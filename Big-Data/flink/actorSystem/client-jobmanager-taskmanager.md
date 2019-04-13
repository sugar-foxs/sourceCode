无论程序是用DataStream还是DataSet编写的，Client 都会转成JobGraph,发送至jobManagaer,jobManager将JobGraph转换成ExecutionGraph,然后执行。
## 过程如下：
- Environment.execute 
- StreamGraphGenerator构建StreamGraph 
- ClustClient.run 
  - StreamingJobGraphGenerator将streamGraph转成JobGraph
  - client submit job 
  - JobManager接收到jobGraph, ExecutionGraphBuilder将jobGraph转ExecutionGraph 
  - ExecutionGraph.scheduleForExecution 
  - scheduleEager/scheduleLazy 
  - allocateResourcesForAll分配资源
  - 所有execution.deploy()
  - 通过TaskManagerGateway向taskamanager提交task(以TaskDeploymentDescriptor形式)
  - taskmanager准备好需要的东西，启动task
  - 进入Task run方法