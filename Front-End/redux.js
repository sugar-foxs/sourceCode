/**
 *
 * @param  {...any} funcs 函数柯里化
 */
const funcA = a => {
  return (funcB = b => {
    return a + b;
  });
};

let compose = (f, g) => x => f(g(x));

function compose(...funcs) {
  if (funcs.length === 0) {
    return arg => arg;
  }
  if (funcs.length === 1) {
    return funcs[0];
  }
  return funcs.reduce((a, b) => (...args) => a(b(...args)));
}

/**
 * applyMiddleware
 */
function applyMiddleware(...middlewares) {
  return createStore => (...args) => {
    const store = createStore(...args);
    let dispatch = () => {
      throw new Error(
        `Dispatching while constructing your middleware is not allowed.`
      );
    };
    const middlewareAPI = {
      getState: store.getState,
      dispatch: (...args) => dispatch(...args)
    };
    const chain = middlewares.map(middleware => middleware(middlewareAPI));
    dispatch = compose(...chain)(store.dispatch);
    return {
      ...store,
      dispatch
    };
  };
}
/**
 *
 * @param {assertReducerShape} reducers
 */
function assertReducerShape(reducers) {
  Object.keys(reducers).forEach(key => {
    const reducer = reducers[key];
    const initialState = reducer(undefined, { type: ActionType.INIT });
  });
}

/**
 * combineReducers
 */
function combineReducers(reducers) {
  const reducersKeys = Object.keys(reducers);
  const finalReducers = {};
  for (let i = 0; i < reducersKeys.length; i++) {
    const key = reducersKeys[i];
    if (process.env.NODE_ENV !== "production") {
      if (typeof reducers[key] === "undefined") {
        console.error("");
      }
    }
    if (typeof reducers[key] === "function") {
      finalReducers[key] = reducers[key];
    }
  }
  let shapeAssertionError;
  try {
    assertReducerShape(finalReducers);
  } catch (e) {
    shapeAssertionError = e;
  }
  const finalReducers = Object.keys(finalReducers);

  assertReducerShape(finalReducers);
  return function combination(state = {}, action) {
    if (shapeAssertionError) {
      throw shapeAssertionError;
    }
    if (process.env.NODE_ENV !== "production") {
      const warningMessage = getUnexpectedStateShapeWarningMessage(
        state,
        finalReducers,
        action,
        unexpectedKeyCache
      );
      if (warningMessage) {
        console.error(warningMessage);
      }
    }
    let hasChanged = false;
    const nextState = {};
    for (let i = 0; i < finalReducers.length; i++) {
      const key = finalReducerKeys[i];
      const reducer = finalReducers[key];
      const previousStateForKey = state[key];
      const nextStateForKey = reducer(previousStateForKey, action);
      if (typeof nextStateForKey === "undefined") {
        const errorMessage = getUnexpectedStateShapeWarningMessage(key, action);
        throw new Error(errorMessage);
      }
      nextState[key] = nextStateForKey;
      hasChanged = hasChanged || nextStateForKey !== previousStateForKey;
    }
    return hasChanged ? nextState : state;
  };
}

export default function createStore(reducer, initialState, enhancer) {
    if(typeof enhancer !== 'undefined') {
        if(typeof enhancer !=='function') {
            throw new Error('expected to be function')
        }
        return enhancer(createStore)(reducer, initialState)
    }
    var isDispatching = false
    var currentReducer = reducer
    try {
        isDispatching = true
        currentState = currentReducer(currentState,action)
    } finally {
        isDispatching = false
    }
    
}
