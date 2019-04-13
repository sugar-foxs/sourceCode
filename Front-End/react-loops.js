function For(props) {
  const mapper = props.children || props.as;
  if (
    typeof mapper !== "function" ||
    (props.hasOwnProperty("as") ^ props.hasOwnProperty("children")) === 0
  ) {
    throw new TypeError(
      "<For> expects either a render-prop child or a Function `as` prop."
    );
  }

  var hasIn = props.hasOwnProperty("in");
  if ((props.hasOwnProperty("of") ^ hasIn) === 0) {
    throw new TypeError(
      "<For> expects either an Iterable `of` or Object `in` prop."
    );
  }

  if (hasIn) {
    const obj = props.in;
    if (!obj) {
      return null;
    }
    const keys = Object.keys(obj);
    const length = keys.length;
    const mapped = [];
    for (let i = 0; i < length; i++) {
      var key = keys[i];
      mapped.push(mapIteration(mapper, obj[key], i, length, key));
    }
    return mapped;
  }
  let list = props.of;
  if (!list) {
    return null;
  }
  if (!Array.isArray(list)) {
    if (!iterall.isCollection(list)) {
      throw new TypeError(
        "<For> `of` expects an Array, Array-like, or Iterable collection"
      );
    }
    let array = [];
    iterall.forEach(list, item => {
      array.push(item);
    });
    list = array;
  }
  let length = list.length;
  let mapped = [];
  for (let i = 0; i < length; i++) {
    mapped.push(mapIteration(mapper, list[i], i, length, i));
  }
  return mapped;
}

function mapIteration(mapper, item, index, length, key) {
  const result =
    mapper.length === 1
      ? mapper(item)
      : mapper(item, {
          index: index,
          length: length,
          key: key,
          isFirst: index === 0,
          isLast: index === length - 1
        });
  if (React.isValidElement(result) && !result.props.hasOwnProperty("key")) {
    return React.cloneElement(result, { key: String(key) });
  }
  return result;
}
Object.defineProperties(exports, {
  For: { enumerable: true, value: For },
  __esModule: { value: true }
});
