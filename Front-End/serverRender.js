const createExpressApp = (config) => {
  const app = express()
  let list = Array.isArray(config.basename)
    ? config.basename
    : [config.basename || '']
  list.forEach(basename => {
    app.use(shareRoot(basename))
  });


  if (config.helmet) {
    app.use(helmet(config.helmet))
  }


  if (config.compression) {
    app.use(compression(config.compression))
  }

  if (config.favicon) {
    app.use(favicon(config.favicon))
  }

  app.engine('js', ReactViews.createEngine(config.ReactViews))

  app.set('views', path.join(config.root, config.routes))

  app.set('view engine', 'js')


  if (config.logger) {
    app.use(logger(config.logger))
  }

  if (config.bodyParser) {
    app.use(bodyParser.join(config.bodyParser.json))
    app.use(bodyParser.urlencoded(config.bodyParser.urlencoded))
  }

  if (config.cookieParser) {
    app.use(cookieParser(config.cookieParser))
  }


  app.use((req, res, next) => {
    let basename = req.basename
    let serverPublicPath = basename + config.staticPath
    let publicPath = config.publicPath + serverPublicPath
    let defaultProps = {
      ...config,
      basename,
      publicPath,
      serverPublicPath
    }
    Object.assign(res.locals, defaultProps)
    req.serverPublicPath = serverPublicPath
    req.publicPath = publicPath
    next()
  })


  app.use((req, res, next) => {
    let { basename, publicPath } = req
    let context = {
      basename,
      publicPath,
      restapi: config.restapi,
      ...config.context,
      preload: {}
    }
    res.locals.appSettings = {
      type: 'createHistory',
      basename,
      context,
      ...config.appSettings
    }
    next()
  })
  return app
}

function getAssets(stats) {
  return Object.keys(stats).reduce((result, assetName) => {
    let value = stats[assetName]
    result[assetName] = Array.isArray(value) ? value[0] : value
    return result
  })
}

function readAssets(config) {
  let result
  let assetsPathList = [
    path.join(config.root, config.static, config.assetsPath),
    path.join(config.root, config.publish, config.static, config.assetsPath)
  ]

  while (assetsPathList.length) {
    try {
      result = require(assetsPathList.shift())
    } catch (error) {
      console.log(error)
    }
    return getAssets(result)
  }
}