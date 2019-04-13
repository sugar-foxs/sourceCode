const isObj = obj => {
  return Object.prototype.toString.call(obj) === "[object object]";
};
const isFn = obj => {
  return typeof obj === "function";
};
const isThenable = obj => {
  return obj != null && isObj(obj.then);
};
// 实现一个简单的状态管理器
export default function createStore(actions, initialState) {
  let listeners = [];
  let subscribe = listener => {
    listeners.push(listener);
    return () => {
      let index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    };
  };
  let publish = data => {
    listeners.forEach(listener => listener(data));
  };
  let currentState = initialState;
  let getState = () => currentState;
  let replaceState = (nextState, data, silent) => {
    if (data && data.isAsync) {
      currentState = {
        ...currentState,
        ...nextState
      };
    } else {
      currentState = nextState;
    }
    if (!silent) {
      publish(data);
    }
  };
  let isDispatching = false;
  let dispatch = (actionType, actionPayload) => {
    if (isDispatching) {
      throw new Error(`store.dispatch(actionType,actionPayload)`);
    }
    let start = new Date();
    let nextState = currentState;
    try {
      isDispatching = true;
      nextState = actions[actionType](currentState, actionPayload);
    } catch (error) {
      throw error;
    } finally {
      isDispatching = false;
    }
    let isAsync = false;
    let updateState = nextState => {
      if (isFn(nextState)) {
        return updateState(nextState(currentState, actionPayload));
      }
      if (isThenable(nextState)) {
        isAsync = true;
        return nextState.then(updateState);
      }
      if (nextState === currentState) {
        return currentState;
      }
      replaceState(nextState, {
        isAsync,
        start,
        end: new Date(),
        actionType,
        actionPayload,
        previousState: currentState,
        currentState: nextState
      });
      return nextState;
    };
    return updateState(nextState);
  };
  let store = {
    getState,
    replaceState,
    dispatch,
    subscribe,
    publish
  };
  store.actions = Object.keys(actions).reduce((obj, actionType) => {
    if (isFn(actions[actionType])) {
      obj[actionType] = actionPayload =>
        store.dispatch(actionType, actionPayload);
    }
    return obj;
  }, {});
  return store;
}
