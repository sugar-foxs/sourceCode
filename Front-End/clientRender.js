import Controller from "./controller";

const getMoule = module => module.default || module

let shouldHydrate = !!window.__INITIAL_STATE__

const render = (view, container, controller) => {
  try {
    if (shouldHydrate) {
      shouldHydrate = false
      ReactDOM.hydrate(view, container)
    } else {
      ReactDOM.render(view, container)
    }
  } catch (error) {
    console.log(error)
  }
}

const viewEngine = { render }

const appSettings = {
  hashType: 'hashbang',
  container: "#root",
  context: {
    preload: {},
    isClient: true,
    isServer: false
  },
  loader: webpackLoader,
  routes,
  viewEngine
}

const preload = {}
Array.from(document.querySelectorAll('[data-preload]')).forEach(elem => {
  let name = elem.getAttribute('data-preload')
  let content = elem.textContent || elem.innerHTML
  preload[name] = content
})
appSettings.context.preload = preload

const app = createApp(appSettings)

app.start()