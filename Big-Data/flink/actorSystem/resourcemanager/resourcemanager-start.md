# 启动
FlinkResourceManager.startResourceManagerActors方法。
```java
public static ActorRef startResourceManagerActors(
        Configuration configuration,
        ActorSystem actorSystem,
        LeaderRetrievalService leaderRetriever,
        Class<? extends FlinkResourceManager<?>> resourceManagerClass,
        String resourceManagerActorName) {

    Props resourceMasterProps = getResourceManagerProps(
        resourceManagerClass,
        configuration,
        leaderRetriever);

    return actorSystem.actorOf(resourceMasterProps, resourceManagerActorName);
}
```
actorSystem.actorOf方法通过prop里的class创建子Actor，resourceManagerClass继承自FlinkResourceManager。比较常用的是StandaloneResourceManager和YarnFlinkResourceManager。


