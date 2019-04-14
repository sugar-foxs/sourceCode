# SourceStreamTask
SourceStreamTask是job执行的第一个task，分别看下SourceStreamTask的init和run方法：
- init
```java
protected void init() {
// 源在从检查点协调器接收到触发器消息时不会触发检查点，但是当其输入数据/事件指示应触发检查点时
SourceFunction<?> source = headOperator.getUserFunction();
if (source instanceof ExternallyInducedSource) {
externallyInducedCheckpoints = true;

ExternallyInducedSource.CheckpointTrigger triggerHook = new ExternallyInducedSource.CheckpointTrigger() {
    @Override
    public void triggerCheckpoint(long checkpointId) throws FlinkException {
        final CheckpointOptions checkpointOptions = CheckpointOptions.forCheckpointWithDefaultLocation();
        final long timestamp = System.currentTimeMillis();
        final CheckpointMetaData checkpointMetaData = new CheckpointMetaData(checkpointId, timestamp);
        try {
            SourceStreamTask.super.triggerCheckpoint(checkpointMetaData, checkpointOptions);
        }
        catch (RuntimeException | FlinkException e) {
            throw e;
        }
        catch (Exception e) {
            throw new FlinkException(e.getMessage(), e);
        }
    }
};
((ExternallyInducedSource<?, ?>) source).setCheckpointTrigger(triggerHook);
}
}
```
init方法只有关于source是ExternallyInducedSource是checkpoint的逻辑。

- 看下run方法:
```java
protected void run() throws Exception {
headOperator.run(getCheckpointLock(), getStreamStatusMaintainer());
}
```
run方法直接执行headOperator的run方法，在SourceStreamTask中headOperator是StreamSource类型。所有执行的是StreamSource的run方法，继续看下
```java
public void run(final Object lockingObject,
    final StreamStatusMaintainer streamStatusMaintainer,
    final Output<StreamRecord<OUT>> collector) throws Exception {

final TimeCharacteristic timeCharacteristic = getOperatorConfig().getTimeCharacteristic();
// 创建LatencyMark发射器，定时产生LatencyMarker
LatencyMarksEmitter latencyEmitter = null;
if (getExecutionConfig().isLatencyTrackingEnabled()) {
    latencyEmitter = new LatencyMarksEmitter<>(
        getProcessingTimeService(),
        collector,
        getExecutionConfig().getLatencyTrackingInterval(),
        this.getOperatorID(),
        getRuntimeContext().getIndexOfThisSubtask());
}
final long watermarkInterval = getRuntimeContext().getExecutionConfig().getAutoWatermarkInterval();
this.ctx = StreamSourceContexts.getSourceContext(
    timeCharacteristic,
    getProcessingTimeService(),
    lockingObject,
    streamStatusMaintainer,
    collector,
    watermarkInterval,
    -1);

try {
    // 执行用户代码逻辑
    userFunction.run(ctx);

    if (!isCanceledOrStopped()) {
        ctx.emitWatermark(Watermark.MAX_WATERMARK);
    }
} finally {
    ctx.close();
    if (latencyEmitter != null) {
        latencyEmitter.close();
    }
}
}
```

- getSourceContext方法根据3种不同的TimeCharacteristic，生成不同类型的WatermarkContext，用于发射数据。
```java
public static <OUT> SourceFunction.SourceContext<OUT> getSourceContext(
        TimeCharacteristic timeCharacteristic,
        ProcessingTimeService processingTimeService,
        Object checkpointLock,
        StreamStatusMaintainer streamStatusMaintainer,
        Output<StreamRecord<OUT>> output,
        long watermarkInterval,
        long idleTimeout) {
    final SourceFunction.SourceContext<OUT> ctx;
    switch (timeCharacteristic) {
        case EventTime:
            ctx = new ManualWatermarkContext<>(
                output,
                processingTimeService,
                checkpointLock,
                streamStatusMaintainer,
                idleTimeout);
            break;
        case IngestionTime:
            ctx = new AutomaticWatermarkContext<>(
                output,
                watermarkInterval,
                processingTimeService,
                checkpointLock,
                streamStatusMaintainer,
                idleTimeout);
            break;
        case ProcessingTime:
            ctx = new NonTimestampContext<>(checkpointLock, output);
            break;
        default:
            throw new IllegalArgumentException(String.valueOf(timeCharacteristic));
    }
    return ctx;
}
```