#ThreadLocal
- ThreadLoal变量是线程局部变量，同一个ThreadLocal所包含的对象，在不同的线程中有不同的副本
- ThreadLocal适用于每个线程需要独立的实例且该实例需要在多个方法中被使用，即变量在线程间隔离而在方法或类间共享的场景。
下面看下TheadLocal是如何实现的：
- 看下set方法
```java
public void set(T value) {
    // 获取当前线程
    Thread t = Thread.currentThread();
    // 获取ThreadLocalMap，没有就新建一个并初始化
    ThreadLocalMap map = getMap(t);
    if (map != null)
        map.set(this, value);
    else
        createMap(t, value);
}
```
- getMap方法是获取Thread的threadLocals变量（类型是ThreadLocalMap，ThreadLocal的静态内部类），每个线程里面都会存储一个ThreadLocalMap变量。
- 就是说value是存储在ThreadLocalMap里的。现在看下ThreadLocalMap是什么结构。
- ThreadLocalMap中的变量
```java
// ThreadLocalMap内部存的是Entry数组，Entry继承自弱引用,key为ThreadLocal对象的弱引用
static class Entry extends WeakReference<ThreadLocal<?>> {
    Object value;
    Entry(ThreadLocal<?> k, Object v) {
        super(k);
        value = v;
    }
}
// 初始容量16
private static final int INITIAL_CAPACITY = 16;
// 存放键值对
private Entry[] table;
private int size = 0;
// 扩容阈值
private int threshold;
```
- 看下set方法，key是ThreadLocal,value是我们设置的值。
```java
private void set(ThreadLocal<?> key, Object value) {
    // Entry数组
    Entry[] tab = table;
    int len = tab.length;
    // 通过ThreadLocal的hash值&len-1获取数组下标
    int i = key.threadLocalHashCode & (len-1);

    for (Entry e = tab[i];
            e != null;
            e = tab[i = nextIndex(i, len)]) {
        ThreadLocal<?> k = e.get();

        if (k == key) {
            e.value = value;
            return;
        }
        // 因为key是弱引用，需要处理key为null的情况，把key为null的Entry清理掉
        if (k == null) {
            replaceStaleEntry(key, value, i);
            return;
        }
    }
    tab[i] = new Entry(key, value);
    int sz = ++size;
    if (!cleanSomeSlots(i, sz) && sz >= threshold)
        rehash();
}
```

- ThreadLocal的get方法调用的是ThreadLocalMap的getEntry方法
```java
private Entry getEntry(ThreadLocal<?> key) {
    int i = key.threadLocalHashCode & (table.length - 1);
    Entry e = table[i];
    if (e != null && e.get() == key)
        return e;
    else
        return getEntryAfterMiss(key, i, e);
}
```
- 通过hash值找到下标，获取Entry。
- 如果通过下标没找到，继续向后找，key为null的会被清理，找不到则返回null。
- 终止条件是e==null,所有e为null后面的key为null的Entry不会被清理。
```java
private Entry getEntryAfterMiss(ThreadLocal<?> key, int i, Entry e) {
    Entry[] tab = table;
    int len = tab.length;
    while (e != null) {
        ThreadLocal<?> k = e.get();
        if (k == key)
            return e;
        if (k == null)
            expungeStaleEntry(i);
        else
            i = nextIndex(i, len);
        e = tab[i];
    }
    return null;
}
```

### 总结
- ThreadLocal将数据存放在内部类ThreadLocalMap中。
- ThreadLocalMap内部是一个Entry数组,Entry继承自WeakReference，Entry内部的value用来存放通过ThreadLocal的set方法传递的值。
- 在ThreadLocalMap的set，get，remove方法中，会对key为null的项进行清理。

### 留下问题：为什么使用弱引用？