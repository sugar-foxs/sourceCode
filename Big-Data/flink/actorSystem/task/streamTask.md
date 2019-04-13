# StreamTask
现在看下streamTask的invoke方法执行了什么操作。
- 初始化
```java
// 线程池
asyncOperationsThreadPool = Executors.newCachedThreadPool();
// 创建同步/异步checkpoint异常处理器
CheckpointExceptionHandlerFactory cpExceptionHandlerFactory = createCheckpointExceptionHandlerFactory();
synchronousCheckpointExceptionHandler = cpExceptionHandlerFactory.createCheckpointExceptionHandler(
    getExecutionConfig().isFailTaskOnCheckpointError(),
    getEnvironment());
asynchronousCheckpointExceptionHandler = new AsyncCheckpointExceptionHandler(this);
// 构造StateBackend，决定了state存储在哪里
stateBackend = createStateBackend();
checkpointStorage = stateBackend.createCheckpointStorage(getEnvironment().getJobID());
// 构造TimeServiceProvider
if (timerService == null) {
    ThreadFactory timerThreadFactory = new DispatcherThreadFactory(TRIGGER_THREAD_GROUP,
        "Time Trigger for " + getName(), getUserCodeClassLoader());
    timerService = new SystemProcessingTimeService(this, getCheckpointLock(), timerThreadFactory);
}
// 构造operatorChain，这个构造过程会在另一篇中介绍
operatorChain = new OperatorChain<>(this, streamRecordWriters);
headOperator = operatorChain.getHeadOperator();

// 每个子类的初始化
init();

// 判断状态
if (canceled) {
    throw new CancelTaskException();
}
```


- invoke
```java
// 加锁，确保在所有operator开启之前，任何triggers不能开启
synchronized (lock) {
    // 初始化operator状态
    initializeState();
    // 开启所有operator
    openAllOperators();
}

// run之前再判断一次状态
if (canceled) {
    throw new CancelTaskException();
}
// 执行每个子类task的真正逻辑
isRunning = true;
run();

// 判断状态
if (canceled) {
    throw new CancelTaskException();
}
// task执行结束
// 加锁，关闭所有operator,timer
synchronized (lock) {
    // 这里失败，task也算失败
    closeAllOperators();
    timerService.quiesce();
    isRunning = false;
}

// 确保所有timers结束
timerService.awaitPendingAfterQuiesce();
// 确保刷新所有缓存数据
operatorChain.flushOutputs();
// 尝试释放operator
tryDisposeAllOperators();
disposed = true;
```

### 下面看下operator初始化状态做了什么工作
进入了AbstractStreamOperator.initializeState方法，所有的operator都执行是这个方法。
```java
public final void initializeState() throws Exception {
    // 从配置中获取key的序列化器
    final TypeSerializer<?> keySerializer = config.getStateKeySerializer(getUserCodeClassloader());
    // 获取包含此operator的task
    final StreamTask<?, ?> containingTask =
        Preconditions.checkNotNull(getContainingTask());
    final CloseableRegistry streamTaskCloseableRegistry =
        Preconditions.checkNotNull(containingTask.getCancelables());
    final StreamTaskStateInitializer streamTaskStateManager =
        Preconditions.checkNotNull(containingTask.createStreamTaskStateInitializer());

    final StreamOperatorStateContext context =
        streamTaskStateManager.streamOperatorStateContext(
            getOperatorID(),
            getClass().getSimpleName(),
            this,
            keySerializer,
            streamTaskCloseableRegistry);
    
    this.operatorStateBackend = context.operatorStateBackend();
    this.keyedStateBackend = context.keyedStateBackend();

    if (keyedStateBackend != null) {
        this.keyedStateStore = new DefaultKeyedStateStore(keyedStateBackend, getExecutionConfig());
    }

    timeServiceManager = context.internalTimerServiceManager();
    CloseableIterable<KeyGroupStatePartitionStreamProvider> keyedStateInputs = context.rawKeyedStateInputs();
    CloseableIterable<StatePartitionStreamProvider> operatorStateInputs = context.rawOperatorStateInputs();

    try {
        StateInitializationContext initializationContext = new StateInitializationContextImpl(
            context.isRestored(), // 表明这是restore还是第一次启动
            operatorStateBackend,
            keyedStateStore,
            keyedStateInputs, 
            operatorStateInputs);
        // 这个方法里面为空，默认什么都不做，具有可还原状态的operator需要重写这个方法。
        initializeState(initializationContext);
    } finally {
        closeFromRegistry(operatorStateInputs, streamTaskCloseableRegistry);
        closeFromRegistry(keyedStateInputs, streamTaskCloseableRegistry);
    }
}
```
- operatorStateBackend,keyedStateBackend,keyedStateInputs和operatorStateInputs都是在streamOperatorStateContext方法中构建,并用来构建StateInitializationContext，这个类是每个operator执行初始化的入参类型。看下具体怎么构建的：
```java
public StreamOperatorStateContext streamOperatorStateContext(
    @Nonnull OperatorID operatorID,
    @Nonnull String operatorClassName,
    @Nonnull KeyContext keyContext,
    @Nullable TypeSerializer<?> keySerializer,
    @Nonnull CloseableRegistry streamTaskCloseableRegistry) throws Exception {

    TaskInfo taskInfo = environment.getTaskInfo();
    OperatorSubtaskDescriptionText operatorSubtaskDescription =
        new OperatorSubtaskDescriptionText(
            operatorID,
            operatorClassName,
            taskInfo.getIndexOfThisSubtask(),
            taskInfo.getNumberOfParallelSubtasks());

    final String operatorIdentifierText = operatorSubtaskDescription.toString();

    final PrioritizedOperatorSubtaskState prioritizedOperatorSubtaskStates =
        taskStateManager.prioritizedOperatorState(operatorID);

    AbstractKeyedStateBackend<?> keyedStatedBackend = null;
    OperatorStateBackend operatorStateBackend = null;
    CloseableIterable<KeyGroupStatePartitionStreamProvider> rawKeyedStateInputs = null;
    CloseableIterable<StatePartitionStreamProvider> rawOperatorStateInputs = null;
    InternalTimeServiceManager<?> timeServiceManager;

    try {

        // -------------- Keyed State Backend --------------
        keyedStatedBackend = keyedStatedBackend(
            keySerializer,
            operatorIdentifierText,
            prioritizedOperatorSubtaskStates,
            streamTaskCloseableRegistry);

        // -------------- Operator State Backend --------------
        operatorStateBackend = operatorStateBackend(
            operatorIdentifierText,
            prioritizedOperatorSubtaskStates,
            streamTaskCloseableRegistry);

        // -------------- Raw State Streams --------------
        rawKeyedStateInputs = rawKeyedStateInputs(
            prioritizedOperatorSubtaskStates.getPrioritizedRawKeyedState().iterator());
        streamTaskCloseableRegistry.registerCloseable(rawKeyedStateInputs);

        rawOperatorStateInputs = rawOperatorStateInputs(
            prioritizedOperatorSubtaskStates.getPrioritizedRawOperatorState().iterator());
        streamTaskCloseableRegistry.registerCloseable(rawOperatorStateInputs);

        // -------------- Internal Timer Service Manager --------------
        timeServiceManager = internalTimeServiceManager(keyedStatedBackend, keyContext, rawKeyedStateInputs);

        // -------------- Preparing return value --------------

        return new StreamOperatorStateContextImpl(
            prioritizedOperatorSubtaskStates.isRestored(),
            operatorStateBackend,
            keyedStatedBackend,
            timeServiceManager,
            rawOperatorStateInputs,
            rawKeyedStateInputs);
    } catch (Exception ex) {
        ...
    }
}

```

### 总结
- 所以真正的逻辑在每个StreamTask执行run方法里，在执行run之前，做了以下准备：
    - 构造线程池
    - 创建同步/异步checkpoint异常处理器
    - 构造StateBackend，决定了state存储在哪里
    - 构造TimeServiceProvider
    - 构造operatorChain
    - 每个子类的个性初始化
    - 初始化所有operator状态
    - 开启所有operator
