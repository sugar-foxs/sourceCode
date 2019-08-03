# AOP
## aop的概念
aop是面向切面编程，但通俗来讲，举个例子：
- 程序中有些方法在方法入口需要权限验证，程序中所有的方法其实都是joint point(连接点)，意思是说所有方法都可能需要权限验证
- 但是哪些方法需要权限验证呢，这时候就需要point cut（切点）来过滤出需要权限验证的方法，只有符合切点条件的方法才会进行权限验证。point cut就相当于过滤规则。 
- 过滤完之后，权限验证的具体操作就是advice，这个advice可以在joint point之前、之后或者环绕执行。
- 最后aop中的aspect的概念就是point cut和advice的总和。即根据条件point cut找到需要执行advice的方法。

## aop的两种实现方式
spring中是使用了动态代理。
### 静态代理
在程序运行前已经存在代理类的字节码的文件，也就是在编译时期已经完成代理工作。

### 动态代理（JDK动态代理和CGLIB动态代理）
在程序运行期间由Java反射等机制动态生成，也就是在将class加载到jvm时期完成的工作。这种方式是不会修改字节码。
#### JDK动态代理
- spring中jdk动态代理的实现是JdkDynamicAopProxy类，底层调用的是jdk的Proxy类的newProxyInstance方法。
- Proxy.newProxyInstance(ClassLoader loader,Class<?>[] interfaces,InvocationHandler h);
- JDK动态代理的核心是InvocationHandler接口和Proxy类。
- loader是目标类的classLoader对象。
- interfaces是被代理实现的接口，生成的代理对象也会实现这些接口。
- InvocationHandler中只有invoke方法，是上述说的advice的具体逻辑。

- newProxyInstance返回的是代理类，代理类实现了目标对象实现的接口，代理类实在运行时动态生成的类。
- 代理类执行接口的方法，实际会去执行InvocationHandler的invoke方法，invoker放法中包含了advice的代码和实际目标对象的代码。

##### newProxyInstance方法具体实现
```java
public static Object newProxyInstance(ClassLoader loader,Class<?>[] interfaces,InvocationHandler h)
throws IllegalArgumentException
    {
        Objects.requireNonNull(h);

        final Class<?>[] intfs = interfaces.clone();
        final SecurityManager sm = System.getSecurityManager();
        if (sm != null) {
            checkProxyAccess(Reflection.getCallerClass(), loader, intfs);
        }

        /*
         * 代理类的class对象
         */
        Class<?> cl = getProxyClass0(loader, intfs);

        /*
         * Invoke its constructor with the designated invocation handler.
         */
        try {
            if (sm != null) {
                checkNewProxyPermission(Reflection.getCallerClass(), cl);
            }
            // 调用代理对象的构造方法
            final Constructor<?> cons = cl.getConstructor(constructorParams);
            final InvocationHandler ih = h;
            //修饰符不是public，设置可访问
            if (!Modifier.isPublic(cl.getModifiers())) {
                AccessController.doPrivileged(new PrivilegedAction<Void>() {
                    public Void run() {
                        cons.setAccessible(true);
                        return null;
                    }
                });
            }
            // 生成代理类的实例并把InvocationHandler的实例传给它的构造方法
            return cons.newInstance(new Object[]{h});
        } catch (IllegalAccessException|InstantiationException e) {
            throw new InternalError(e.toString(), e);
        } catch (InvocationTargetException e) {
            Throwable t = e.getCause();
            if (t instanceof RuntimeException) {
                throw (RuntimeException) t;
            } else {
                throw new InternalError(t.toString(), t);
            }
        } catch (NoSuchMethodException e) {
            throw new InternalError(e.toString(), e);
        }
    }
```

- 为什么会执行invoke方法呢？
    - 因为在生成的代理对象中，InvocationHandler被传递进去作为构造函数的参数了，在实现接口的方法内部，调用了InvocationHandler类的invoke方法。
    - 具体的代理类代码就不看了，在运行时才会生成。

#### CGLIB动态代理
- 使用JDK动态代理，目标类必须实现接口，但是CGLIB动态代理是通过生成被代理的子类实现的，不需要强制要求被代理类实现接口，所以可以弥补JDK动态代理的弱点。
- CGLIB动态代理点核心是Enhancer,MethodInterceptor。

```java
public Object getProxy(ClassLoader classLoader) {
		...
		try {
			Class<?> rootClass = this.advised.getTargetClass();
			Assert.state(rootClass != null, "Target class must be available for creating a CGLIB proxy");
            // 目标类作为代理类的父类
			Class<?> proxySuperClass = rootClass;
			if (ClassUtils.isCglibProxyClass(rootClass)) {
				proxySuperClass = rootClass.getSuperclass();
				Class<?>[] additionalInterfaces = rootClass.getInterfaces();
				for (Class<?> additionalInterface : additionalInterfaces) {
					this.advised.addInterface(additionalInterface);
				}
			}

			// Validate the class, writing log messages as necessary.
			validateClassIfNecessary(proxySuperClass, classLoader);

			// Configure CGLIB Enhancer...
			Enhancer enhancer = createEnhancer();
			if (classLoader != null) {
				enhancer.setClassLoader(classLoader);
				if (classLoader instanceof SmartClassLoader &&
						((SmartClassLoader) classLoader).isClassReloadable(proxySuperClass)) {
					enhancer.setUseCache(false);
				}
			}
			enhancer.setSuperclass(proxySuperClass);
			enhancer.setInterfaces(AopProxyUtils.completeProxiedInterfaces(this.advised));
			enhancer.setNamingPolicy(SpringNamingPolicy.INSTANCE);
			enhancer.setStrategy(new ClassLoaderAwareUndeclaredThrowableStrategy(classLoader));

			Callback[] callbacks = getCallbacks(rootClass);
			Class<?>[] types = new Class<?>[callbacks.length];
			for (int x = 0; x < types.length; x++) {
				types[x] = callbacks[x].getClass();
			}
			// fixedInterceptorMap only populated at this point, after getCallbacks call above
			enhancer.setCallbackFilter(new ProxyCallbackFilter(
					this.advised.getConfigurationOnlyCopy(), this.fixedInterceptorMap, this.fixedInterceptorOffset));
			enhancer.setCallbackTypes(types);

			// 通过字节码技术动态创建子类实例
			return createProxyClassAndInstance(enhancer, callbacks);
		}
		catch ...
	}
```
MethodInterceptor是Callback的子接口，程序中只要实现MethodInterceptor就可以，实现MethodInterceptor的intercept拦截方法。这个就是aop中的advice。


