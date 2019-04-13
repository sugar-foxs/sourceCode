# Task处理消息之SubmitTask消息
taskmanager即受到Submittask消息之后，提交任务的过程如下：（入参是tdd,类型是TaskDeploymentDescriptor，包含了启动任务所需的所有东西）
## 构建task之前的一些准备：
- 获取jobManagerActor，用于和jobmanager通信
- 获取libraryCacheManager，用于下载libraries,和创建job的类加载器。
- 获取blobCache，Blob缓存为永久和临时Blob提供对Blob服务的访问。
- 获取fileCache，用于在部署任务时访问已注册的缓存文件。
- 获取slot数量
- 获取CheckpointResponder，用于构造RuntimeEnvironment，具体作用后面分析。
- 获取PartitionProducerStateChecker，用于分区生产者状态检查。
- 获取ResultPartitionConsumableNotifier，用于构造ResultPartition，具体作用后面分析。
- 获取TaskManagerActions，用来更新task状态。
- 将外部数据从Blob存储区加载回对象，因为部分数据可能由于量较大，不方便通过rpc传输，会先持久化，然后在这里再加载回来。
- 反序列化job信息，并验证jobId
- 反序列化task信息
- 构建TaskInputSplitProvider
- 注册taskLocalStateStore，用于构建taskStateManager。
- 新建taskStateManager，用与构建RuntimeEnvironment,具体作用后面分析，可以知道的是它用于通知checkpoint完成。

## 构建task，之前的的一切都是为了构建Task做准备。
```java
val task = new Task(
    jobInformation,
    taskInformation,
    tdd.getExecutionAttemptId,
    tdd.getAllocationId,
    tdd.getSubtaskIndex,
    tdd.getAttemptNumber,
    tdd.getProducedPartitions,
    tdd.getInputGates,
    tdd.getTargetSlotNumber,
    memoryManager,
    ioManager,
    network,
    bcVarManager,
    taskStateManager,
    taskManagerConnection,
    inputSplitProvider,
    checkpointResponder,
    blobCache,
    libCache,
    fileCache,
    config,
    taskMetricGroup,
    resultPartitionConsumableNotifier,
    partitionStateChecker,
    context.dispatcher)
```
- 执行task.startTaskThread(),执行Task实例中的executingThread这个变量表示的线程.
task作为这个线程的参数，Task实现了Runnable，所以最后执行的是Task的run方法。

## 进入Task的run方法
从下面几个步骤进行分析：
- 先进入一个while（true）循环,直到成功使用CAS将状态从created到deploying，跳出循环进入下一步。如果状态是失败或者取消中则直接返回。
- 下面是一个try-catch-finally块。分步看下try里的内容。
- 下载jar包
```java
//激活任务线程的安全网
FileSystemSafetyNet.initializeSafetyNetForThread();
//持久化的blob服务注册job
blobService.getPermanentBlobService().registerJob(jobId);
//首先, 获取一个 user-code 类加载器,这可能涉及下载作业的JAR文件或class文件
userCodeClassLoader = createUserCodeClassloader();
final ExecutionConfig executionConfig = serializedExecutionConfig.deserializeValue(userCodeClassLoader);
if (executionConfig.getTaskCancellationInterval() >= 0) {
    // 尝试取消task时, 两次尝试之间的时间间隔, 单位毫秒
    taskCancellationInterval = executionConfig.getTaskCancellationInterval();
}
if (executionConfig.getTaskCancellationTimeout() >= 0) {
    // 取消任务的超时时间, 可以在flink的配置中覆盖
    taskCancellationTimeout = executionConfig.getTaskCancellationTimeout();
}
//如果当前状态'CANCELING'、'CANCELED'、'FAILED', 则抛出异常
if (isCanceledOrFailed()) {
    throw new CancelTaskException();
}
```
- 一些相关注册
```java
// 网络注册任务
network.registerTask(this);
// 注册network metrics，省略了
// 启动为分布式缓存进行文件的后台拷贝
try {
    for (Map.Entry<String, DistributedCache.DistributedCacheEntry> entry :
            DistributedCache.readFileInfoFromConfig(jobConfiguration)) {
        LOG.info("Obtaining local cache file for '{}'.", entry.getKey());
        Future<Path> cp = fileCache.createTmpFile(entry.getKey(), entry.getValue(), jobId, executionId);
        distributedCacheEntries.put(entry.getKey(), cp);
    }
}
catch (Exception e) {
    ...
}
// 再次检查状态
if (isCanceledOrFailed()) {
    throw new CancelTaskException();
}
```
- 用户代码初始化
```java
// 构建用于单个任务的kvstate注册的辅助程序
TaskKvStateRegistry kvStateRegistry = network.createKvStateTaskRegistry(jobId, getJobVertexId());
// 运行时环境
Environment env = new RuntimeEnvironment(
    jobId,
    vertexId,
    executionId,
    executionConfig,
    taskInfo,
    jobConfiguration,
    taskConfiguration,
    userCodeClassLoader,
    memoryManager,
    ioManager,
    broadcastVariableManager,
    taskStateManager,
    accumulatorRegistry,
    kvStateRegistry,
    inputSplitProvider,
    distributedCacheEntries,
    producedPartitions,
    inputGates,
    network.getTaskEventDispatcher(),
    checkpointResponder,
    taskManagerConfig,
    metrics,
    this);

// 加载并实例化AbstractInvokable的具体子类
invokable = loadAndInstantiateInvokable(userCodeClassLoader, nameOfInvokableClass, env);
```

- 真正的执行过程
```java
this.invokable = invokable;

// 状态切换到running
if (!transitionState(ExecutionState.DEPLOYING, ExecutionState.RUNNING)) {
    throw new CancelTaskException();
}
// 告诉每个人, 我们切换到'RUNNING'状态了 
notifyObservers(ExecutionState.RUNNING, null);
taskManagerActions.updateTaskExecutionState(new TaskExecutionState(jobId, executionId, ExecutionState.RUNNING));
// 设置线程上下文类加载器
executingThread.setContextClassLoader(userCodeClassLoader);
// 真正的执行逻辑在这
// AbstractInvokable子类的具体执行过程以后再分析
invokable.invoke();
// 再次检查状态
if (isCanceledOrFailed()) {
    throw new CancelTaskException();
}
```
- 成功执行后的收尾工作
```java
// 完成生产数据分区。如果这里失败, 任务执行也算失败
for (ResultPartition partition : producedPartitions) {
    if (partition != null) {
        partition.finish();
    }
}
// 尝试将状态从'RUNNING'修改为'FINISHED'，如果失败, 那么task是同一时间被执行了 canceled/failed 操作。
// 并通知状态观察者们。
if (transitionState(ExecutionState.RUNNING, ExecutionState.FINISHED)) {
    notifyObservers(ExecutionState.FINISHED, null);
}
else {
    throw new CancelTaskException();
}
```

AbstractInvokable子类的invoke方法之后具体介绍。