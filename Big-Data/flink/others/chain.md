# 判断edge是否属于chain需要同时满足的条件：
- 1,下游streamNode的输入边为1；
- 2，输入输出node的operator不为null；
- 3，输入输出node在同一个slot group；
- 4,outOperator的成链规则是ChainingStrategy.ALWAYS；
- 5，输入operator的成链规则是ChainingStrategy.HEAD或者ChainingStrategy.ALWAYS；
- 6，channelselector是ForwardPartitioner类型
- 7，输入输出node并行度相同；
- 8，isChainingEnabled;



1,没有selector
output数量为1，返回第一个output.
output数量大于1，返回BroadcastingOutputCollector(outputs)。BroadcastingOutputCollector也是继承自OutPut,它里面放了所有的基础output。基础output是CopyingchainingOutput和RecordWriterOutput.
2,有selector
默认使用DirectedOutput，包含了所有的outputs和selectors.

所以operator的output基础类型是两种：RecordWriterOutPut,ChainingOutput

看下Output如何将数据往下游传输：
1，RecordWriterOutPut:
- 传输record
-> out.collect(record);
-> StreamRecordWriter.emit
-> RecordWiter.emit
-> 根据channelSelector类型执行不同的选择channel的方法，来获取channel。
-> 使用sendToTarget(record, targetChannel);发送给channel.

- 传输watermark
public void broadcastEmit(T record) throws IOException, InterruptedException {
	for (int targetChannel = 0; targetChannel < numChannels; targetChannel++) {
		sendToTarget(record, targetChannel);
	}
}
发送给每个channel.
- 传输latencyMarker
public void randomEmit(T record) throws IOException, InterruptedException {
	sendToTarget(record, rng.nextInt(numChannels));
}
latencyMarker随机发送一个channel。

2,ChainingOutput 在operatorChain中的operator间传输
- 传输record
out.collect(record)
-> operator.processElement(record);
-> 调用用户逻辑
-> 用户程序里还是调用的out.collect(这里的out类型不定)

- 传输watermark
watermarkGauge.setCurrentWatermark(mark.getTimestamp());
if (streamStatusProvider.getStreamStatus().isActive()) {
	operator.processWatermark(mark);
}

- 传输latencyMarker
operator.processLatencyMarker(latencyMarker);


## channelSlector


## 
StreamGraph -> StreamingPlan -> FlinkPlan
               OptimizePlan  -> FlinkPlan

Environment.execute 
-> StreamGraphGenerator生成StreamGraph 
-> ClustClient.run 
-> StreamingJobGraphGenerator将streamGraph转JobGraph 
-> client submit job 
-> JobSubmissionClientActor 
-> JObManager接收到jobGraph, ExecutionGraphBuilder将jobGraph转ExecutionGraph 
-> ExecutionGraph.scheduleForExecution 
-> scheduleEager/scheduleLazy 
-> allocateResourcesForAll分配资源
-> 所有execution.deploy()
-> 通过TaskManagerGateway向taskamanager提交task(以TaskDeploymentDescriptor形式)
-> taskmanager准备好需要的东西，启动task
-> 进入Task run方法
	cas 状态从created到deploying
	-> 下载jar
	-> 使用网络栈注册任务
	-> 启动分布式缓存在后台复制 
	-> cas 任务状态改为running
	-> 加载并实例化任务的可调用代码
   		-> 将runtimeEnvironment作为参数传入构造器，实例化task
	-> 进入具体每个task的invoke方法，例如：Streamtask.invoke()
		-> 生成operatorChain
		-> 执行run方法，例如SourceStreamTask.run
			-> headOperator.run,定时生成latencyMarker,传递给下一个operator.
	-> execution执行之后，关闭ResultPartition
	-> cas 任务状态改为finished


所以需要清楚operator的连接方式才能知道如何传输数据的。

# operatorChain，在同一个线程内的operator之键
数据不需要经过序列化和写到多线程共享的buffer中， 直接调用下游operator的processElement方法传递数据。

# 同一个进程的不同线程之间通信
RecordWriter.sendToTraget()

# 不同进程之间通信

## sendToTarget
跨节点传输streamRecord,watermark,latencyMarker最终都是调用的sendToTarget方法。只是选择channel方法不一样。
-> 取出对应channel的序列化器,目前只有SpanningRecordSerializer类型。
将完整记录序列化到中间数据序列化缓冲区，并使用continueWritingWithNextBufferBuilder（BufferBuilder）逐个将此缓冲区复制到目标缓冲区。
-> 写入DataOutputSerializer，返回SerializationResult（isFullRecord,isFullBuffer）.isFullRecord表示record写完了，isFullBuffer表示内存段已满。
-> BufferBuilder不为null,continueWritingWithNextBufferBuilder（BufferBuilder），如果BufferBuilder为null,申请新的BufferBuilder，直到数据全部写进buffer.
-> 如果flushAlways为true,targetPartition.flush(targetChannel)。通知所有消费者进行消费
	-> PipelinedSubpartition: buffer放在ArrayDeque中，
	-> SpillableSubpartition: 
-> ResultSubpartitionView 是消费ResultSubpartition的



## 构建operatorChain过程
-> 入参是包含这个operatorChain的Task和streamRecordWriters。
-> StreamRecordWriter主要包含ResultPartitionWriter，StreamPartitioner，OutputFlusher。
	-> ResultPartitionWriter是面向缓冲区的运行时结果写入器，用于生成结果。在这是task中的ResultPartition,表示单个task输出的结果分区。
	-> StreamPartitioner是流中使用的channel选择器。
	-> OutputFlusher是一个线程，定时执行ResultPartitionWriter.flushAll,执行所有的子结果分区ResultSubPartition的flush方法,刷到buffer中。
	-> 子结果分区有两种实现：PipelinedSubpartition，SpillableSubpartition。

### operator的产生，存储在operatorChain中，由StreamTask产生
```java
		public OperatorChain(
			StreamTask<OUT, OP> containingTask,
			List<StreamRecordWriter<SerializationDelegate<StreamRecord<OUT>>>> streamRecordWriters) {

		final ClassLoader userCodeClassloader = containingTask.getUserCodeClassLoader();
		final StreamConfig configuration = containingTask.getConfiguration();

		headOperator = configuration.getStreamOperator(userCodeClassloader);

		// we read the chained configs, and the order of record writer registrations by output name
		Map<Integer, StreamConfig> chainedConfigs = configuration.getTransitiveChainedTaskConfigsWithSelf(userCodeClassloader);

		// create the final output stream writers
		// we iterate through all the out edges from this job vertex and create a stream output
		List<StreamEdge> outEdgesInOrder = configuration.getOutEdgesInOrder(userCodeClassloader);
		Map<StreamEdge, RecordWriterOutput<?>> streamOutputMap = new HashMap<>(outEdgesInOrder.size());
		this.streamOutputs = new RecordWriterOutput<?>[outEdgesInOrder.size()];

		// from here on, we need to make sure that the output writers are shut down again on failure
		boolean success = false;
		try { 
            //每个edge对应一个output
			for (int i = 0; i < outEdgesInOrder.size(); i++) {
				StreamEdge outEdge = outEdgesInOrder.get(i);

				RecordWriterOutput<?> streamOutput = createStreamOutput(
					streamRecordWriters.get(i),
					outEdge,
					chainedConfigs.get(outEdge.getSourceId()),
					containingTask.getEnvironment());

				this.streamOutputs[i] = streamOutput;
				streamOutputMap.put(outEdge, streamOutput);
			}

			// we create the chain of operators and grab the collector that leads into the chain
			List<StreamOperator<?>> allOps = new ArrayList<>(chainedConfigs.size());
			this.chainEntryPoint = createOutputCollector(
				containingTask,
				configuration,
				chainedConfigs,
				userCodeClassloader,
				streamOutputMap,
				allOps);

			if (headOperator != null) {
				WatermarkGaugeExposingOutput<StreamRecord<OUT>> output = getChainEntryPoint();
				headOperator.setup(containingTask, configuration, output);

				headOperator.getMetricGroup().gauge(MetricNames.IO_CURRENT_OUTPUT_WATERMARK, output.getWatermarkGauge());
			}

			// 把headOperator加在list最后，因为createOutputCollector方法递归执行，所以operator在list中的顺序和逻辑顺序相反，之后执行的时候从list尾部开始执行
			allOps.add(headOperator);

			this.allOperators = allOps.toArray(new StreamOperator<?>[allOps.size()]);

			success = true;
		}
		finally {
			。。。
		}

	}
```

### createOutputCollector 看下如何递归调用的
```java
		private <T> WatermarkGaugeExposingOutput<StreamRecord<T>> createOutputCollector(
			StreamTask<?, ?> containingTask,
			StreamConfig operatorConfig,
			Map<Integer, StreamConfig> chainedConfigs,
			ClassLoader userCodeClassloader,
			Map<StreamEdge, RecordWriterOutput<?>> streamOutputs,
			List<StreamOperator<?>> allOperators) {
		List<Tuple2<WatermarkGaugeExposingOutput<StreamRecord<T>>, StreamEdge>> allOutputs = new ArrayList<>(4);

		// create collectors for the network outputs
		for (StreamEdge outputEdge : operatorConfig.getNonChainedOutputs(userCodeClassloader)) {
			@SuppressWarnings("unchecked")
			RecordWriterOutput<T> output = (RecordWriterOutput<T>) streamOutputs.get(outputEdge);

			allOutputs.add(new Tuple2<>(output, outputEdge));
		}

		// 递归截止条件是:最后一个operator的operatorConfig.getChainedOutputs为空
		for (StreamEdge outputEdge : operatorConfig.getChainedOutputs(userCodeClassloader)) {
            // 获得下游operator id
			int outputId = outputEdge.getTargetId();
            // 获得下游operator的streamConfig
			StreamConfig chainedOpConfig = chainedConfigs.get(outputId);
            // 根据下游operator的config创建ChainedOperator，返回chain的output
			WatermarkGaugeExposingOutput<StreamRecord<T>> output = createChainedOperator(
				containingTask,
				chainedOpConfig,
				chainedConfigs,
				userCodeClassloader,
				streamOutputs,
				allOperators,
				outputEdge.getOutputTag());
			allOutputs.add(new Tuple2<>(output, outputEdge));
		}
	}
```

### createChainedOperator
```java
	private <IN, OUT> WatermarkGaugeExposingOutput<StreamRecord<IN>> createChainedOperator(
			StreamTask<?, ?> containingTask,
			StreamConfig operatorConfig,
			Map<Integer, StreamConfig> chainedConfigs,
			ClassLoader userCodeClassloader,
			Map<StreamEdge, RecordWriterOutput<?>> streamOutputs,
			List<StreamOperator<?>> allOperators,
			OutputTag<IN> outputTag) {
		// create the output that the operator writes to first. this may recursively create more operators
		WatermarkGaugeExposingOutput<StreamRecord<OUT>> chainedOperatorOutput = createOutputCollector(
			containingTask,
			operatorConfig,
			chainedConfigs,
			userCodeClassloader,
			streamOutputs,
			allOperators);

		// now create the operator and give it the output collector to write its output to
		OneInputStreamOperator<IN, OUT> chainedOperator = operatorConfig.getStreamOperator(userCodeClassloader);

		chainedOperator.setup(containingTask, operatorConfig, chainedOperatorOutput);

		allOperators.add(chainedOperator);

		WatermarkGaugeExposingOutput<StreamRecord<IN>> currentOperatorOutput;
		if (containingTask.getExecutionConfig().isObjectReuseEnabled()) {
			currentOperatorOutput = new ChainingOutput<>(chainedOperator, this, outputTag);
		}
		else {
			TypeSerializer<IN> inSerializer = operatorConfig.getTypeSerializerIn1(userCodeClassloader);
			currentOperatorOutput = new CopyingChainingOutput<>(chainedOperator, inSerializer, outputTag, this);
		}

		chainedOperator.getMetricGroup().gauge(MetricNames.IO_CURRENT_INPUT_WATERMARK, currentOperatorOutput.getWatermarkGauge());
		chainedOperator.getMetricGroup().gauge(MetricNames.IO_CURRENT_OUTPUT_WATERMARK, chainedOperatorOutput.getWatermarkGauge());

		return currentOperatorOutput;
	}
```




