无论程序是用DataStream还是DataSet编写的，Client 都会转成JobGraph,发送至jobManagaer,jobManager将JobGraph转换成ExecutionGraph，


jobManager和taskManager用actor模式通信

### jobManager接收到JobGraph的处理方法：
```java
private def submitJob(jobGraph: JobGraph, jobInfo: JobInfo, isRecovery: Boolean = false): Unit = {
  if (jobGraph == null) {
    jobInfo.notifyClients(
      decorateMessage(JobResultFailure(
        new SerializedThrowable(
          new JobSubmissionException(null, "JobGraph must not be null.")))))
  }
  else {
    val jobId = jobGraph.getJobID
    val jobName = jobGraph.getName
    var executionGraph: ExecutionGraph = null
  
    log.info(s"Submitting job $jobId ($jobName)" + (if (isRecovery) " (Recovery)" else "") + ".")
  
    try {
      // 先设置用户代码库，为了防止在不成功的情况想把已经上传到jars删除
      try {
        libraryCacheManager.registerJob(
          jobGraph.getJobID, jobGraph.getUserJarBlobKeys, jobGraph.getClasspaths)
      }
      catch {
        ...
      }
  
      //获取用户代码的类加载器
      val userCodeLoader = libraryCacheManager.getClassLoader(jobGraph.getJobID)
      if (userCodeLoader == null) {
        throw new JobSubmissionException(jobId,
          "The user code class loader could not be initialized.")
      }
  
      //check jobGraph中task数量
      if (jobGraph.getNumberOfVertices == 0) {
        throw new JobSubmissionException(jobId, "The given job is empty")
      }
  
      //重启策略
      val restartStrategy =
        Option(jobGraph.getSerializedExecutionConfig()
          .deserializeValue(userCodeLoader)
          .getRestartStrategy())
          .map(RestartStrategyFactory.createRestartStrategy)
          .filter(p => p != null) match {
          case Some(strategy) => strategy
          case None => restartStrategyFactory.createRestartStrategy()
        }
  
      // 加入metric group中
      val jobMetrics = jobManagerMetricGroup.addJob(jobGraph)
      // slot数量
      val numSlots = scheduler.getTotalNumberOfSlots()
  
      //是否需要注册新graph
      val registerNewGraph = currentJobs.get(jobGraph.getJobID) match {
        case Some((graph, currentJobInfo)) =>
          executionGraph = graph
          currentJobInfo.setLastActive()
          false
        case None =>
          true
      }
      // 分配的超时时间
      val allocationTimeout: Long = flinkConfiguration.getLong(
        JobManagerOptions.SLOT_REQUEST_TIMEOUT)
  
      //创建executionGraph
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
        Time.milliseconds(allocationTimeout),
        log.logger)
      
      if (registerNewGraph) {
        currentJobs.put(jobGraph.getJobID, (executionGraph, jobInfo))
      }
  
      // 注册job状态监听器
      executionGraph.registerJobStatusListener(
        new StatusListenerMessenger(self, leaderSessionID.orNull))
  
      jobInfo.clients foreach {
        // 注册clinet为executionGraph的状态监听者
        case (client, ListeningBehaviour.EXECUTION_RESULT_AND_STATE_CHANGES) =>
          val listener  = new StatusListenerMessenger(client, leaderSessionID.orNull)
          executionGraph.registerExecutionListener(listener)
          executionGraph.registerJobStatusListener(listener)
        case _ => // do nothing
      }
  
    } catch {
      //通知client任务失败
    }
  
    // 恢复措施，将jobGraph写入SubmittedJobGraphStore（异步）
    future {
      try {
        if (isRecovery) {
          //恢复至最新的checkpoint
          executionGraph.restoreLatestCheckpointedState(false, false)
        }
        else {
          // 载入保存点
          val savepointSettings = jobGraph.getSavepointRestoreSettings
          if (savepointSettings.restoreSavepoint()) {
            try {
              val savepointPath = savepointSettings.getRestorePath()
              val allowNonRestored = savepointSettings.allowNonRestoredState()
  
              executionGraph.getCheckpointCoordinator.restoreSavepoint(
                savepointPath, 
                allowNonRestored,
                executionGraph.getAllVertices,
                executionGraph.getUserClassLoader
              )
            } catch {
              ...
            }
          }
  
          try {
            //将提交到jobGraph加入到已提交的jobGraph存储中，如果在zk中运行，则存在ZooKeeperSubmittedJobGraphStore中
            submittedJobGraphs.putJobGraph(new SubmittedJobGraph(jobGraph, jobInfo))
          } catch {
            ...
          }
        }
        //通知clients任务提交成功
        jobInfo.notifyClients(
          decorateMessage(JobSubmitSuccess(jobGraph.getJobID)))
  
        if (leaderElectionService.hasLeadership) {
          //调度executionGraph
          executionGraph.scheduleForExecution()
        } else {
          // 不是leader,删除jobGraph
          self ! decorateMessage(RemoveJob(jobId, removeJobFromStateBackend = false))
        }
      } catch {
        ...
      }
    }(context.dispatcher)
  }
}
```