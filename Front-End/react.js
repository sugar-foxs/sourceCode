/**
 * 简化类型比较
 */
export const NoContext = 0b000
export const AsyncMode = 0b001
export const StrictMode = 0b010
export const ProfileMode = 0b100

/**
 * react 核心
 * 1、更新机制
 * 2、Fiber
 * 3、React实现路更新任务的调度，如何实现。
 */

function randomHexColor() {
  return "#" + ("0000" + (Math.random() * 0x1000000 << 0).toString(16)).substr(-6)
}
setTimeout(function () {
  var k = 0;
  var root = document.getElementById('root')
  for (var i = 0; i < 10000; i++) {
    k += new Date - 0
    var el = document.createElement('div')
    el.innerHTML = k
    root.appendChild(el)
    el.style.cssText = `background:${randomHexColor()};height:40px`
  }
})


/**
 * ReactDOM.render
 */

var queue = []
ReactDOM.render = function (root, container) {
  queue.push(root)
  updateFiberAndView()
}
function getVdomFormQueue() {
  return queue.shift()
}
function Fiber(vnode) {
  for (var i in vnode) {
    this[i] = vnode[i]
  }
  this.uuid = Math.random()
}

function toFiber(vnode) {
  if (!vnode.uuid) {
    return new Fiber(vnode)
  }
  return vnode
}

function updateFiberAndView() {
  var now = new Date - 0;
  var deadline = new Date + 100
  updateView()
  if (new Date < deadline) {
    var vdom = getVdomFormQueue()
    var fiber = vdom, firstFiber
    var hasVisited = {}
    do {
      var fiber = toFiber(fiber)
      if (!firstFiber) {
        firstFiber = fiber
      }
      if (!hasVisited[fiber.uuid]) {
        hasVisited[fiber.uuid] = 1
        updateComponentOrElement(fiber)
        if (fiber.child) {
          if (newDate - 0 > deadline) {
            queue.push(fiber.child)
            break
          }
          fiber = fiber.child
          continue
        }
      }
      if (fiber.sibling) {
        fiber = fiber.sibling
        continue
      }
      fiber = fiber.return
      if (fiber === firstFiber || !fiber) {
        break
      }
    } while (1)
  }
  if (queue.length) {
    setTimeout(updateFiberAndView, 40)
  }
}

