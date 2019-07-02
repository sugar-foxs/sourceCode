# jobGraph的生成过程
生成JobGraph的入口是StreamingJobGraphGenerator.createJobGraph()。
```java
private JobGraph createJobGraph() {
    // 调度模式是所有节点一起启动
    jobGraph.setScheduleMode(ScheduleMode.EAGER);

    // 为每个节点生成hash值
    Map<Integer, byte[]> hashes = defaultStreamGraphHasher.traverseStreamGraphAndGenerateHashes(streamGraph);

    // 生成旧版本哈希以实现向后兼容性
    List<Map<Integer, byte[]>> legacyHashes = new ArrayList<>(legacyStreamGraphHashers.size());
    for (StreamGraphHasher hasher : legacyStreamGraphHashers) {
        legacyHashes.add(hasher.traverseStreamGraphAndGenerateHashes(streamGraph));
    }

    Map<Integer, List<Tuple2<byte[], byte[]>>> chainedOperatorHashes = new HashMap<>();
    // 最重要的函数，生成JobVertex，JobEdge等，并尽可能地将多个节点chain在一起
    setChaining(hashes, legacyHashes, chainedOperatorHashes);
    // 将每个JobVertex的入边集合也序列化到该JobVertex的StreamConfig中
    setPhysicalEdges();
    // 根据group name，为每个 JobVertex 指定所属的 SlotSharingGroup 
    // 以及针对 Iteration的头尾设置  CoLocationGroup
    setSlotSharingAndCoLocation();
    // 配置checkpoint
    configureCheckpointing();
    // 添加在taskmanager上运行作业所需的自定义文件的路径
    JobGraphGenerator.addUserArtifactEntries(streamGraph.getEnvironment().getCachedFiles(), jobGraph);
    // 将 StreamGraph 的 ExecutionConfig 序列化到 JobGraph 的配置中
    try {
        jobGraph.setExecutionConfig(streamGraph.getExecutionConfig());
    }
    catch (IOException e) {
        throw new IllegalConfigurationException("Could not serialize the ExecutionConfig." +
                "This indicates that non-serializable types (like custom serializers) were registered");
    }
    return jobGraph;
}
```
- 重要逻辑在setChaining方法里，下面看下具体逻辑：
```java
private void setChaining(Map<Integer, byte[]> hashes, List<Map<Integer, byte[]>> legacyHashes, Map<Integer, List<Tuple2<byte[], byte[]>>> chainedOperatorHashes) {
    // 从source开始建立node chains
    for (Integer sourceNodeId : streamGraph.getSourceIDs()) {
        createChain(sourceNodeId, sourceNodeId, hashes, legacyHashes, 0, chainedOperatorHashes);
    }
}
// 构建node chains，返回当前节点的物理出边
// startNodeId != currentNodeId 时,说明currentNode是chain中的子节点
private List<StreamEdge> createChain(
        Integer startNodeId,
        Integer currentNodeId,
        Map<Integer, byte[]> hashes,
        List<Map<Integer, byte[]>> legacyHashes,
        int chainIndex,
        Map<Integer, List<Tuple2<byte[], byte[]>>> chainedOperatorHashes) {
    if (!builtVertices.contains(startNodeId)) {
        List<StreamEdge> transitiveOutEdges = new ArrayList<StreamEdge>();
        List<StreamEdge> chainableOutputs = new ArrayList<StreamEdge>();
        List<StreamEdge> nonChainableOutputs = new ArrayList<StreamEdge>();

        for (StreamEdge outEdge : streamGraph.getStreamNode(currentNodeId).getOutEdges()) {
            if (isChainable(outEdge, streamGraph)) {
                chainableOutputs.add(outEdge);
            } else {
                nonChainableOutputs.add(outEdge);
            }
        }

        for (StreamEdge chainable : chainableOutputs) {
            transitiveOutEdges.addAll(
                    createChain(startNodeId, chainable.getTargetId(), hashes, legacyHashes, chainIndex + 1, chainedOperatorHashes));
        }

        for (StreamEdge nonChainable : nonChainableOutputs) {
            transitiveOutEdges.add(nonChainable);
            createChain(nonChainable.getTargetId(), nonChainable.getTargetId(), hashes, legacyHashes, 0, chainedOperatorHashes);
        }

        List<Tuple2<byte[], byte[]>> operatorHashes =
            chainedOperatorHashes.computeIfAbsent(startNodeId, k -> new ArrayList<>());
        byte[] primaryHashBytes = hashes.get(currentNodeId);

        for (Map<Integer, byte[]> legacyHash : legacyHashes) {
            operatorHashes.add(new Tuple2<>(primaryHashBytes, legacyHash.get(currentNodeId)));
        }

        chainedNames.put(currentNodeId, createChainedName(currentNodeId, chainableOutputs));
        chainedMinResources.put(currentNodeId, createChainedMinResources(currentNodeId, chainableOutputs));
        chainedPreferredResources.put(currentNodeId, createChainedPreferredResources(currentNodeId, chainableOutputs));

        StreamConfig config = currentNodeId.equals(startNodeId)
                ? createJobVertex(startNodeId, hashes, legacyHashes, chainedOperatorHashes)
                : new StreamConfig(new Configuration());

        setVertexConfig(currentNodeId, config, chainableOutputs, nonChainableOutputs);

        if (currentNodeId.equals(startNodeId)) {
            config.setChainStart();
            config.setChainIndex(0);
            config.setOperatorName(streamGraph.getStreamNode(currentNodeId).getOperatorName());
            config.setOutEdgesInOrder(transitiveOutEdges);
            config.setOutEdges(streamGraph.getStreamNode(currentNodeId).getOutEdges());

            for (StreamEdge edge : transitiveOutEdges) {
                connect(startNodeId, edge);
            }

            config.setTransitiveChainedTaskConfigs(chainedConfigs.get(startNodeId));
        } else {

            Map<Integer, StreamConfig> chainedConfs = chainedConfigs.get(startNodeId);

            if (chainedConfs == null) {
                chainedConfigs.put(startNodeId, new HashMap<Integer, StreamConfig>());
            }
            config.setChainIndex(chainIndex);
            StreamNode node = streamGraph.getStreamNode(currentNodeId);
            config.setOperatorName(node.getOperatorName());
            chainedConfigs.get(startNodeId).put(currentNodeId, config);
        }

        config.setOperatorID(new OperatorID(primaryHashBytes));

        if (chainableOutputs.isEmpty()) {
            config.setChainEnd();
        }
        return transitiveOutEdges;
    } else {
        return new ArrayList<>();
    }
}
```
