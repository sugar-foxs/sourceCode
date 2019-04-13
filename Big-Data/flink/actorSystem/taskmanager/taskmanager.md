## TaskManager
- TaskManager负责执行Flink job的各个任务，其有以下几个阶段：
	* 等待被注册： 周期的发送RegisterTaskManager消息给jobManager，直到注册成功，jobManager会回复AcknowledgeRegistration消息，然后taskManager初始化所有组件。
	* 接收处理消息：如，SubmitTask, CancelTask, FailTask

## TaskManager 启动
- 首先创建HA服务，获取网络端口，重点在runTaskManager方法
```java
val highAvailabilityServices = HighAvailabilityServicesUtils.createHighAvailabilityServices(
	configuration,
	Executors.directExecutor(),
	AddressResolution.TRY_ADDRESS_RESOLUTION)

val (taskManagerHostname, actorSystemPortRange) = selectNetworkInterfaceAndPortRange(
	configuration,
	highAvailabilityServices)

try {
	runTaskManager(
		taskManagerHostname,
		resourceID,
		actorSystemPortRange,
		configuration,
		highAvailabilityServices,
		taskManagerClass)
} finally {
	...
}
```
- 进入runTaskManager方法，看下具体流程。
```java
def runTaskManager(
		taskManagerHostname: String,
		resourceID: ResourceID,
		actorSystemPort: Int,
		configuration: Configuration,
		highAvailabilityServices: HighAvailabilityServices,
		taskManagerClass: Class[_ <: TaskManager])
	: Unit = {

	// 首先创建TaskManager actor system，并绑定地址
	val taskManagerSystem = BootstrapTools.startActorSystem(
		configuration,
		taskManagerHostname,
		actorSystemPort,
		LOG.logger)
  // metrics相关
	val metricRegistry = new MetricRegistryImpl(
		MetricRegistryConfiguration.fromConfiguration(configuration))
	metricRegistry.startQueryService(taskManagerSystem, resourceID)

	// 开启所有taskManager组件和actor
	try {
		val taskManager = startTaskManagerComponentsAndActor(
			configuration,
			resourceID,
			taskManagerSystem,
			highAvailabilityServices,
			metricRegistry,
			taskManagerHostname,
			Some(TaskExecutor.TASK_MANAGER_NAME),
			localTaskManagerCommunication = false,
			taskManagerClass)

		// 开启监听taskManager的进程，如果taskManager actor die，可以kill JVM进程
		taskManagerSystem.actorOf(
			Props(classOf[ProcessReaper], taskManager, LOG.logger, RUNTIME_FAILURE_RETURN_CODE),
			"TaskManager_Process_Reaper")

		// 启动TaskManager隔离监视器
		if (configuration.getBoolean(TaskManagerOptions.EXIT_ON_FATAL_AKKA_ERROR)) {
			val quarantineHandler = new DefaultQuarantineHandler(
				Time.milliseconds(AkkaUtils.getTimeout(configuration).toMillis),
				RUNTIME_FAILURE_RETURN_CODE,
				LOG.logger)
			taskManagerSystem.actorOf(
				Props(classOf[QuarantineMonitor], quarantineHandler, LOG.logger)
			)
		}

		// 日志相关
		if (LOG.isInfoEnabled && configuration.getBoolean(
			TaskManagerOptions.DEBUG_MEMORY_LOG))
		{
			LOG.info("Starting periodic memory usage logger")

			val interval = configuration.getLong(
				TaskManagerOptions.DEBUG_MEMORY_USAGE_LOG_INTERVAL_MS)

			val logger = new MemoryLogger(LOG.logger, interval, taskManagerSystem)
			logger.start()
		}

		// 阻塞，直至系统关闭
		taskManagerSystem.awaitTermination()
	} catch {
		。。。
	}

	// 关闭metrics查询服务
	try {
		metricRegistry.shutdown().get()
	} catch {
		。。。
	}
}
```

## taskmanager中包含的属性及组件
```java
//等待future超时时间
otected val askTimeout = new Timeout(config.getTimeout().getSize, config.getTimeout().getUnit())
//TaskManager执行需要的资源，包含numberOfCPUCores, sizeOfPhysicalMemory, sizeOfJvmHeap, managedMemory
prected val resources = HardwareDescription.extractFromSystem(memoryManager.getMemorySize())
//存储TaskManager当前执行的所有Task的map
protected val runningTasks = new java.util.HashMap[ExecutionAttemptID, Task]()
//用来在task之间广播变量
protected val bcVarManager = new BroadcastVariableManager()
//用来缓存分布式文件
protected val fileCache = new FileCache(config.getTmpDirectories())
// leader选举服务
protected val leaderRetrievalService: LeaderRetrievalService = highAvailabilityServices.
getJobManagerLeaderRetriever(
	HighAvailabilityServices.DEFAULT_JOB_ID)
// metrice相关
private var taskManagerMetricGroup : TaskManagerMetricGroup = _
//存储了taskManager在jobmanager上成功注册之后需要通知的的Actors
private val waitForRegistration = scala.collection.mutable.Set[ActorRef]()
//用来处理TaskManager 文件
private var blobService: Option[BlobService] = None
private var libraryCacheManager: Option[LibraryCacheManager] = None

// 当前连接的JobManager leader
protected var currentJobManager: Option[ActorRef] = None
// 当前连接的JobManager leader URL 
private var jobManagerAkkaURL: Option[String] = None

private var instanceID: InstanceID = null
// 负责心跳
private var heartbeatScheduler: Option[Cancellable] = None

var leaderSessionID: Option[UUID] = None

private var scheduledTaskManagerRegistration: Option[Cancellable] = None
private var currentRegistrationRun: UUID = UUID.randomUUID()

private var connectionUtils: Option[(
CheckpointResponder,
PartitionProducerStateChecker,
ResultPartitionConsumableNotifier,
TaskManagerActions)] = None
```
 

### TaskManager处理接收到的messages，每种消息对应不同的逻辑
```java
override def handleMessage: Receive = {
// 处理task messages，任务调度和任务状态更新相关
case message: TaskMessage => handleTaskMessage(message)

// 处理checkpointing message
case message: AbstractCheckpointMessage => handleCheckpointingMessage(message)

// 通知新的JobManager Leader地址
case JobManagerLeaderAddress(address, newLeaderSessionID) =>
	handleJobManagerLeaderAddress(address, newLeaderSessionID)

// 处理注册JobManager相关消息，例：注册被拒绝，已经注册...
case message: RegistrationMessage => handleRegistrationMessage(message)

// 处理任务栈采样消息
case message: StackTraceSampleMessages => handleStackTraceSampleMessage(message)

// 发送心跳信息给jobManager
case SendHeartbeat => sendHeartbeatToJobManager()

// 返回TaskManager堆栈跟踪
case SendStackTrace => sendStackTrace(sender())

// 在注册到jobManager之后通知消息发送者
case NotifyWhenRegisteredAtJobManager =>
	if (isConnected) {
		sender ! decorateMessage(RegisteredAtJobManager(leaderSessionID.orNull))
	} else {
		waitForRegistration += sender
	}

// jobmanager不可达
case Terminated(actor: ActorRef) =>
	if (isConnected && actor == currentJobManager.orNull) {
			handleJobManagerDisconnect("JobManager is no longer reachable")
			triggerTaskManagerRegistration()
	} else {
		log.warn(s"Received unrecognized disconnect message " +
				s"from ${if (actor == null) null else actor.path}.")
	}

// jobmanager请求断开连接
case Disconnect(instanceIdToDisconnect, cause) =>
	if (instanceIdToDisconnect.equals(instanceID)) {
		handleJobManagerDisconnect(s"JobManager requested disconnect: ${cause.getMessage()}")
		triggerTaskManagerRegistration()
	} else {
		log.debug(s"Received disconnect message for wrong instance id ${instanceIdToDisconnect}.")
	}

//停止集群消息
case msg: StopCluster =>
	log.info(s"Stopping TaskManager with final application status ${msg.finalStatus()} " +
		s"and diagnostics: ${msg.message()}")
	shutdown()

//发生重大错误，要求kill TaskManager actor
case FatalError(message, cause) =>
	killTaskManagerFatal(message, cause)

// 请求TaskManager 日志
case RequestTaskManagerLog(requestType : LogTypeRequest) =>
	blobService match {
		case Some(_) =>
			handleRequestTaskManagerLog(sender(), requestType, currentJobManager.get)
		case None =>
			sender() ! akka.actor.Status.Failure(new IOException("BlobService not " +
				"available. Cannot upload TaskManager logs."))
	}

// 请求广播变量数目
case RequestBroadcastVariablesWithReferences =>
	sender ! decorateMessage(
		ResponseBroadcastVariablesWithReferences(
			bcVarManager.getNumberOfVariablesWithReferences)
	)

// 请求存活连接数
case RequestNumActiveConnections =>
	val numActive = if (!network.isShutdown) {
		network.getConnectionManager.getNumberOfActiveConnections
	} else {
		0
	}

	sender ! decorateMessage(ResponseNumActiveConnections(numActive))
}
```

### 处理与task相关的message
```java
private def handleTaskMessage(message: TaskMessage): Unit = {
	// 判断是否连接上jobManager
	if (!isConnected) {
		log.debug(s"Dropping message $message because the TaskManager is currently " +
			"not connected to a JobManager.")
	} else {
		message match {
		// 通知task 新的输入分区是可用的，即让inputGate添加一个新的inputChannel
		case UpdateTaskSinglePartitionInfo(executionID, resultID, partitionInfo) =>
			updateTaskInputPartitions(
				executionID,
				Collections.singletonList(new PartitionInfo(resultID, partitionInfo)))

		// 通知task 多个新的输入分区是可用的
		case UpdateTaskMultiplePartitionInfos(executionID, partitionInfos) =>
			updateTaskInputPartitions(executionID, partitionInfos)

		// 在取消job之前状态已经是失败或者完成，丢弃某个task生产的结果分区
		case FailIntermediateResultPartitions(executionID) =>
			try {
				network.getResultPartitionManager.releasePartitionsProducedBy(executionID)
			} catch {
				...
			}

		// 更新task执行状态
		case updateMsg @ UpdateTaskExecutionState(taskExecutionState: TaskExecutionState) =>

			// we receive these from our tasks and forward them to the JobManager
			currentJobManager foreach {
				jobManager => {
				val futureResponse = (jobManager ? decorateMessage(updateMsg))(askTimeout)

					val executionID = taskExecutionState.getID

					futureResponse.mapTo[Boolean].onComplete {
						// IMPORTANT: In the future callback, we cannot directly modify state
						//            but only send messages to the TaskManager to do those changes
						case scala.util.Success(result) =>
							if (!result) {
							self ! decorateMessage(
								FailTask(
									executionID,
									new Exception("Task has been cancelled on the JobManager."))
								)
							}

						case scala.util.Failure(t) =>
						self ! decorateMessage(
							FailTask(
								executionID,
								new Exception(
									"Failed to send ExecutionStateChange notification to JobManager", t))
						)
					}(context.dispatcher)
				}
			}

		// 从taskManager删除task，并释放资源
		case TaskInFinalState(executionID) =>
			unregisterTaskAndNotifyFinalState(executionID)

		// 提交新的任务，tdd包含所有开启task需要的信息
		case SubmitTask(tdd) =>
			submitTask(tdd)

		// 标记任务因外部原因失败，外部原因是除了代码自己抛出的错误
		case FailTask(executionID, cause) =>
			val task = runningTasks.get(executionID)
			if (task != null) {
				task.failExternally(cause)
			} else {
			}

		// 停止task
		case StopTask(executionID) =>
			val task = runningTasks.get(executionID)
			if (task != null) {
				try {
					task.stopExecution()
					sender ! decorateMessage(Acknowledge.get())
				} catch {
					case t: Throwable =>
						sender ! decorateMessage(Status.Failure(t))
				}
			} else {
				sender ! decorateMessage(Acknowledge.get())
			}

		// 取消task
		case CancelTask(executionID) =>
			val task = runningTasks.get(executionID)
			if (task != null) {
				task.cancelExecution()
				sender ! decorateMessage(Acknowledge.get())
			} else {
			}
		}
	}
}
```

### 处理checkpoint相关消息
```java
private def handleCheckpointingMessage(actorMessage: AbstractCheckpointMessage): Unit = {
	actorMessage match {
		// 收到checkpointCoordinator发送的触发checkpoint指令
		case message: TriggerCheckpoint =>
			val taskExecutionId = message.getTaskExecutionId
			val checkpointId = message.getCheckpointId
			val timestamp = message.getTimestamp
			val checkpointOptions = message.getCheckpointOptions

			val task = runningTasks.get(taskExecutionId)
			if (task != null) {
				task.triggerCheckpointBarrier(checkpointId, timestamp, checkpointOptions)
			} else {
			}
		// 收到checkpointCoordinator发送的checkpoint完成的消息
		case message: NotifyCheckpointComplete =>
			val taskExecutionId = message.getTaskExecutionId
			val checkpointId = message.getCheckpointId
			val timestamp = message.getTimestamp

			val task = runningTasks.get(taskExecutionId)
			if (task != null) {
				task.notifyCheckpointComplete(checkpointId)
			} else {
			}
		case _ => unhandled(actorMessage)
	}
}
```

### 处理注册相关消息
```java
private def handleRegistrationMessage(message: RegistrationMessage): Unit = {
	message match {
		// 在被通知leader jobmanager选举之后，触发在jobmanager上注册taskmanager
		case TriggerTaskManagerRegistration(
			jobManagerURL,
			timeout,
			deadline,
			attempt,
			registrationRun) =>

			if (registrationRun.equals(this.currentRegistrationRun)) {
				if (isConnected) {
					// this may be the case, if we queue another attempt and
					// in the meantime, the registration is acknowledged
					log.debug(
						"TaskManager was triggered to register at JobManager, but is already registered")
				} else if (deadline.exists(_.isOverdue())) {
					// we failed to register in time. that means we should quit
					log.error("Failed to register at the JobManager withing the defined maximum " +
											"connect time. Shutting down ...")

					// terminate ourselves (hasta la vista)
					self ! decorateMessage(PoisonPill)
				} else {
					if (!jobManagerAkkaURL.equals(Option(jobManagerURL))) {
						throw new Exception("Invalid internal state: Trying to register at JobManager " +
																	s"$jobManagerURL even though the current JobManagerAkkaURL " +
																	s"is set to ${jobManagerAkkaURL.getOrElse("")}")
					}

					log.info(s"Trying to register at JobManager $jobManagerURL " +
											s"(attempt $attempt, timeout: $timeout)")

					val jobManager = context.actorSelection(jobManagerURL)

					jobManager ! decorateMessage(
						RegisterTaskManager(
							resourceID,
							location,
							resources,
							numberOfSlots)
					)

					// the next timeout computes via exponential backoff with cap
					val nextTimeout = (timeout * 2).min(new FiniteDuration(
						config.getMaxRegistrationPause().toMilliseconds,
						TimeUnit.MILLISECONDS))

					// schedule (with our timeout s delay) a check triggers a new registration
					// attempt, if we are not registered by then
					scheduledTaskManagerRegistration = Option(context.system.scheduler.scheduleOnce(
						timeout,
						self,
						decorateMessage(TriggerTaskManagerRegistration(
							jobManagerURL,
							nextTimeout,
							deadline,
							attempt + 1,
							registrationRun)
						))(context.dispatcher))
				}
			} else {
				log.info(s"Discarding registration run with ID $registrationRun")
			}

		// 注册成功，与jobmanager建立连接
		case AcknowledgeRegistration(id, blobPort) =>
			val jobManager = sender()

			if (isConnected) {
				if (jobManager == currentJobManager.orNull) {
					log.debug("Ignoring duplicate registration acknowledgement.")
				} else {
					log.warn(s"Ignoring 'AcknowledgeRegistration' message from ${jobManager.path} , " +
						s"because the TaskManager is already registered at ${currentJobManager.orNull}")
				}
			} else {
				// 与JobManager建立连接
				try {
					associateWithJobManager(jobManager, id, blobPort)
				} catch {
					case t: Throwable =>
						killTaskManagerFatal(
							"Unable to start TaskManager components and associate with the JobManager", t)
				}
			}

		// 被通知已经注册过了
		case AlreadyRegistered(id, blobPort) =>
			val jobManager = sender()

			if (isConnected) {
				if (jobManager == currentJobManager.orNull) {
					log.debug("Ignoring duplicate registration acknowledgement.")
				} else {
					log.warn(s"Received 'AlreadyRegistered' message from " +
						s"JobManager ${jobManager.path}, even through TaskManager is currently " +
						s"registered at ${currentJobManager.orNull}")
				}
			} else {
				// 在收到AcknowledgeRegistration之前收到这个消息，与JobManager建立连接
				try {
					associateWithJobManager(jobManager, id, blobPort)
				} catch {
					...
				}
			}
		// 注册请求被拒绝
		case RefuseRegistration(reason) =>
			if (currentJobManager.isEmpty) {
				if(jobManagerAkkaURL.isDefined) {
					// 延迟时间之后重新尝试注册
					val delay: FiniteDuration = new FiniteDuration(
						config.getRefusedRegistrationPause().getSize(),
						config.getRefusedRegistrationPause().getUnit())
					val deadline: Option[Deadline] = Option(config.getMaxRegistrationDuration())
						.map {
							duration => new FiniteDuration(duration.getSize(), duration.getUnit()) +
								delay fromNow
						}

					// 重新尝试注册，发送注册请求
					currentRegistrationRun = UUID.randomUUID()

					scheduledTaskManagerRegistration.foreach(_.cancel())

					scheduledTaskManagerRegistration = Option(
						context.system.scheduler.scheduleOnce(delay) {
							self ! decorateMessage(
								TriggerTaskManagerRegistration(
									jobManagerAkkaURL.get,
									new FiniteDuration(
										config.getInitialRegistrationPause().getSize(),
										config.getInitialRegistrationPause().getUnit()),
									deadline,
									1,
									currentRegistrationRun)
							)
						}(context.dispatcher))
				}
			} else {
				// 其实已经和jobmanager建立连接，忽略此消息
				if (sender() == currentJobManager.orNull) {
					log.warn(s"Received 'RefuseRegistration' from the JobManager (${sender().path})" +
						s" even though this TaskManager is already registered there.")
				} else {
					log.warn(s"Ignoring 'RefuseRegistration' from unrelated " +
						s"JobManager (${sender().path})")
				}
			}
		case _ => unhandled(message)
	}
}
```