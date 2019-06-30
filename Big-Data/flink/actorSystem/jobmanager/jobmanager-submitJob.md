## Jobmanager处理SubmitJob

先将submitJob的主要步骤总结写在开头，然后一步步分析。

- 1，通过JobGraph生成ExecutionGraph；
- 2，从CheckpointedState，或者Savepoint恢复；
- 3，为ExecutionVertexS分配资源并提交到taskmanager部署

### 1，**通过JobGraph生成ExecutionGraph**

- jobManager接收到SubmitJob消息后，生成了一个jobInfo对象装载job信息，然后调用submitJob方法。

```java
case SubmitJob(jobGraph, listeningBehaviour) =>
      val client = sender()
      val jobInfo = new JobInfo(client, listeningBehaviour, System.currentTimeMillis(),
        jobGraph.getSessionTimeout)
      submitJob(jobGraph, jobInfo)
```

- 深入submitJob方法，首先判断jobGraph是否为空，如果为空，返回JobResultFailure消息；

```java
if (jobGraph == null) {
      jobInfo.notifyClients(
        decorateMessage(JobResultFailure(
          new SerializedThrowable(
            new JobSubmissionException(null, "JobGraph must not be null.")))))
}
```

- 接着向类库缓存管理器注册该Job相关的库文件、类路径；必须确保该步骤在第一步执行，因为后续产生任何异常可以确保上传的类库和Jar等成功从类库缓存管理器移除。

```java
libraryCacheManager.registerJob(
            jobGraph.getJobID, jobGraph.getUserJarBlobKeys, jobGraph.getClasspaths)
```

- 接下来是获得用户代码的类加载器classLoader以及发生失败时的重启策略restartStrategy；

```java
val userCodeLoader = libraryCacheManager.getClassLoader(jobGraph.getJobID)
val restartStrategy =
    Option(jobGraph.getSerializedExecutionConfig()
        .deserializeValue(userCodeLoader)
        .getRestartStrategy())
        .map(RestartStrategyFactory.createRestartStrategy)
        .filter(p => p != null) match {
        case Some(strategy) => strategy
        case None => restartStrategyFactory.createRestartStrategy()
	}
```

- 接着，获取ExecutionGraph对象的实例。首先尝试从缓存中查找，如果缓存中存在则直接返回，否则直接创建然后加入缓存；
- ExecutionGraph的创建过程在另一篇文章中介绍。
```java
val registerNewGraph = currentJobs.get(jobGraph.getJobID) match {
    case Some((graph, currentJobInfo)) =>
    	executionGraph = graph
    	currentJobInfo.setLastActive()
    	false
    case None =>
    	true
}

val allocationTimeout: Long = flinkConfiguration.getLong(
	JobManagerOptions.SLOT_REQUEST_TIMEOUT)

val resultPartitionLocationTrackerProxy: ResultPartitionLocationTrackerProxy =
	new ResultPartitionLocationTrackerProxy(flinkConfiguration)

executionGraph = ExecutionGraphBuilder.buildGraph(
    executionGraph,
    jobGraph,
    flinkConfiguration,
    futureExecutor,
    ioExecutor,
    scheduler,
    userCodeLoader,
    checkpointRecoveryFactory,
    Time.of(timeout.length, timeout.unit),
    restartStrategy,
    jobMetrics,
    numSlots,
    blobServer,
    resultPartitionLocationTrackerProxy,
    Time.milliseconds(allocationTimeout),
    log.logger)
...
//加入缓存
if (registerNewGraph) {
   currentJobs.put(jobGraph.getJobID, (executionGraph, jobInfo))
}
```

- 注册Job状态变化的事件回调给jobmanager自己;
```java
executionGraph.registerJobStatusListener(
          new StatusListenerMessenger(self, leaderSessionID.orNull))
```

- 注册整个job状态变化事件回调和单个task状态变化回调给client；

```java
jobInfo.clients foreach {
    // the sender wants to be notified about state changes
    case (client, ListeningBehaviour.EXECUTION_RESULT_AND_STATE_CHANGES) =>
    	val listener  = new StatusListenerMessenger(client, leaderSessionID.orNull)
    	executionGraph.registerExecutionListener(listener)
    	executionGraph.registerJobStatusListener(listener)
    case _ => // do nothing
}
```

- 获取executionGraph之后，如何提交job？继续看；

### 2，**从CheckpointedState，或者Savepoint恢复**

- 如果是恢复的job，从最新的checkpoint中恢复；

```java
if (isRecovery) {
    executionGraph.restoreLatestCheckpointedState(false, false)
}
```

- 或者获取savepoint配置，如果配置了savepoint，便从savepoint中恢复；
```java
val savepointSettings = jobGraph.getSavepointRestoreSettings
if (savepointSettings.restoreSavepoint()) {
    try {
        val savepointPath = savepointSettings.getRestorePath()
        val allowNonRestored = savepointSettings.allowNonRestoredState()
        val resumeFromLatestCheckpoint = savepointSettings.resumeFromLatestCheckpoint()

        executionGraph.getCheckpointCoordinator.restoreSavepoint(
            savepointPath,
            allowNonRestored,
            resumeFromLatestCheckpoint,
            executionGraph.getAllVertices,
            executionGraph.getUserClassLoader
        )
    } catch {
    	...
    }
}
```

- 然后通知client任务提交成功消息，至此job提交成功，但是job还没启动，继续看；
```java
jobInfo.notifyClients(
	decorateMessage(JobSubmitSuccess(jobGraph.getJobID)))
```

### 3,为ExecutionVertexS分配资源并提交到taskmanager部署
- 判断jobmanager是否是leader,如果是leader,执行scheduleForExecution方法进行调度；否则删除job。
```java
if (leaderSessionID.isDefined &&
    leaderElectionService.hasLeadership(leaderSessionID.get)) {
    executionGraph.scheduleForExecution()
} else {
	self ! decorateMessage(RemoveJob(jobId, removeJobFromStateBackend = false))
	log.warn(s"Submitted job $jobId, but not leader. The other leader needs to recover " +
	"this. I am not scheduling the job for execution.")
}
```

- 接着看scheduleForExecution是如何调度的。
- 如果cas将状态成功从created转成running,则根据不同调度模式，执行不同调度逻辑。
```java
switch (scheduleMode) {
	case LAZY_FROM_SOURCES:
		newSchedulingFuture = scheduleLazy(slotProvider);
		break;
	case EAGER:
		newSchedulingFuture = scheduleEager(slotProvider, allocationTimeout);
		break;
	default:
		throw new JobException("Schedule mode is invalid.");
}
```
- 上面两种模式只是决定了一开始哪些ExecutionVertex被调度，LAZY_FROM_SOURCES模式只启动source, EAGER模式启动所有的。
- 决定了哪些EcecutionVertex被调度之后，首先为它们分配资源，allocateAndAssignSlotForExecution方法负责分配。
```java
public CompletableFuture<Execution> allocateAndAssignSlotForExecution(
		SlotProvider slotProvider,
		boolean queued,
		LocationPreferenceConstraint locationPreferenceConstraint,
		Time allocationTimeout) throws IllegalExecutionStateException {

	// 省略检查

	final SlotSharingGroup sharingGroup = vertex.getJobVertex().getSlotSharingGroup();
	final CoLocationConstraint locationConstraint = vertex.getLocationConstraint();

	if (transitionState(CREATED, SCHEDULED)) {
		// CAS成功改变task状态从已创建到已调度
		final SlotSharingGroupId slotSharingGroupId = sharingGroup != null ? sharingGroup.getSlotSharingGroupId() : null;

		ScheduledUnit toSchedule = locationConstraint == null ?
				new ScheduledUnit(this, slotSharingGroupId) :
				new ScheduledUnit(this, slotSharingGroupId, locationConstraint);

		// 尝试获取上一次的分配id,如果适用，以便我们重新安排到同一个slot
		ExecutionVertex executionVertex = getVertex();
		AllocationID lastAllocation = executionVertex.getLatestPriorAllocation();
		Collection<AllocationID> previousAllocationIDs =
			lastAllocation != null ? Collections.singletonList(lastAllocation) : Collections.emptyList();
		// 计算出最合适的位置
		final CompletableFuture<Collection<TaskManagerLocation>> preferredLocationsFuture =
			calculatePreferredLocations(locationPreferenceConstraint);
		final SlotRequestId slotRequestId = new SlotRequestId();
		// 关键分配资源的逻辑在slotProvider.allocateSlot方法中
		final CompletableFuture<LogicalSlot> logicalSlotFuture = preferredLocationsFuture
			.thenCompose(
				(Collection<TaskManagerLocation> preferredLocations) ->
					slotProvider.allocateSlot(
						slotRequestId,
						toSchedule,
						queued,
						new SlotProfile(
							ResourceProfile.UNKNOWN,
							preferredLocations,
							previousAllocationIDs),
						allocationTimeout));
		//省略针对future的一些处理
	}
	else {
		throw new IllegalExecutionStateException(this, CREATED, state);
	}
}
```

- 然后进行部署，最终调用的都是每个Execution的deploy方法。deploy负责将task提交到taskManagerGateway，然后由taskManagerGateway转发给Taskmanager。TaskManager如何处理SubmitTask消息之后分析。
```java
public void deploy() throws JobException {
	final LogicalSlot slot  = assignedResource;
	// cas更新到部署中状态
	ExecutionState previous = this.state;
	if (previous == SCHEDULED || previous == CREATED) {
		if (!transitionState(previous, DEPLOYING)) {
			throw new IllegalStateException("Cannot deploy task: Concurrent deployment call race.");
		}
	}
	else {
		throw new IllegalStateException("The vertex must be in CREATED or SCHEDULED state to be deployed. Found state " + previous);
	}
	// 检查是否分配到分配的slot中
	if (this != slot.getPayload()) {
		throw new IllegalStateException(
			String.format("The execution %s has not been assigned to the assigned slot.", this));
	}
	try {
		// 再次检查状态
		if (this.state != DEPLOYING) {
			slot.releaseSlot(new FlinkException("Actual state of execution " + this + " (" + state + ") does not match expected state DEPLOYING."));
			return;
		}
		final TaskDeploymentDescriptor deployment = vertex.createDeploymentDescriptor(
			attemptId,
			slot,
			taskRestore,
			attemptNumber);
		// 便于gc回收
		taskRestore = null;
		final TaskManagerGateway taskManagerGateway = slot.getTaskManagerGateway();
		// 提交task到taskmanager
		final CompletableFuture<Acknowledge> submitResultFuture = taskManagerGateway.submitTask(deployment, rpcTimeout); 
		submitResultFuture.whenCompleteAsync(
			(ack, failure) -> {
				// 失败处理
				...
			},
			executor);
	} catch (Throwable t) {
		markFailed(t);
		ExceptionUtils.rethrow(t);
	}
}
```