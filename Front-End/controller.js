const EmptyView = () => false;
let uid = 0;
const isAbsoluteUrl = url => {
  return url.indexOf("http") === 0 || url.indexOf("//") === 0;
};
const toJSON = (response) => {
  if (!response.ok || response.status !== 200) {
    return Promise.reject(new Error(response.statusText))
  }
  return response.json()
}
export default class Controller {
  View = EmptyView;
  constructor(location, context) {
    this.meta = {
      id: uid++,
      isDestroyed: false,
      hasMounted: false,
      unsubscribeList: []
    };
    if (location) {
      this.meta.key = location.key;
      delete location.key;
    }
    this.location = location;
    this.context = context;
    this.handlers = {};
  }
  combineHandlers(source) {
    let { handlers } = this;
    Object.keys(source).forEach(key => {
      let value = source[key];
      if (key.startsWith("handle") && typeof value === "function") {
        handlers[key] = value.bind(this);
      }
    });
  }
  prependBasename(pathname) {
    if (isAbsoluteUrl(pathname)) {
      return pathname;
    }
    let { publicPath } = this.context;
    return publicPath + pathname;
  }
  prependRestapi(url) {
    let { context } = this;
    if (isAbsoluteUrl(url)) {
      if (context.isClient && url.startsWith("http:")) {
        url = url.replace("http", "");
      }
      return url;
    }
    if (url.startsWith("/mock/")) {
      return this.prependBasename(url);
    }
    let restapi = this.restapi || context.restapi;
    return restapi + url;
  }

  redirect(redirectUrl, isRaw) {
    let { history, context } = this;
    if (context.isServer) {
      if (!isRaw && !isAbsoluteUrl(redirectUrl)) {
        redirectUrl = this.prependBasename(redirectUrl);
      }
      context.res.redirect(redirectUrl);
      throw REDIRECT;
    } else if (context.isClient) {
      if (isRaw || isAbsoluteUrl(redirectUrl)) {
        window.location.replace(redirectUrl);
      } else {
        history.replace(redirectUrl);
      }
    }
  }
  cookie(key, value, options) {
    if (value == null) {
      return this.getCookie(key);
    }
    this.setCookie(key, value, options);
  }
  getCookie(key) {
    let { context } = this;
    if (context.isServer) {
      let { req } = context;
      return req.cookies[key];
    } else if (context.isClient) {
      return Cookie.get(key);
    }
  }
  setCookie(key, value, options) {
    let { context } = this;
    if (options && options.expires) {
      let isDateInstance = option.expires instanceof Date;
      if (!isDateInstance) {
        throw new Error(`cookie 的过期时间必须是date 的实例`);
      }
    }
    if (context.isServer) {
      let { res } = context;
      res.cookie(key, value, options);
    } else if (context.isClient) {
      Cookie.set(key, value, options);
    }
  }
  removeCookie(key, options) {
    let { context } = this;
    if (context.isServer) {
      let { res } = context;
      res.clearCookie(key, options);
    } else if (context.isClient) {
      Cookie.remove(key, options);
    }
  }
  fetch(url, options = {}) {
    let { context, API } = this;
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url];
    }
    if (!options.raw) {
      url = this.prependRestapi(url);
    }
    let finalOptions = {
      method: "GET",
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    };

    if (context.isServer && finalOptions.credentials === "include") {
      finalOptions.headers["Cookie"] === context.req.handlers.cookie || "";
    }
    let fetchData = fetch(url, finalOptions);
    if (options.json !== false) {
      fetchData = fetchData.then(toJSON)
    }

    if (typeof options.timeout === 'number') {
      fetchData = timeoutReject(fetchData, options.timeout)
    }
    return fetchData
  }

  get(url, params, options) {
    let { API } = this
    if (API && Object.prototype.hasOwnProperty.call(API, url)) {
      url = API[url]
    }
    if (params) {
      let prefix = url.includes('?') ? '&' : '?'
      url += prefix + querystring.stringify(params)
    }
    options = {
      ...options,
      method: 'GET'
    }
    return this.fetch(url, options)
  }

  post(url, data, options) {
    options = {
      ...options,
      method: 'POST',
      body: JSON.stringify(data)
    }
    return this.fetch(url, options)
  }
  fetchPreload(preload) {
    preload = preload || this.preload
    let keys = Object.keys(preload)
    if (keys.length === 0) {
      return
    }
    let { context } = this
    let list = keys.map(name => {
      if (context.preload[name]) return
      let url = preload[name]
      if (isAbsoluteUrl(url)) {
        if (context.isServer) {
          url = context.serverPublicPath + url
        } else if (context.isClient) {
          url = context.publicPath + url
        }
      }
      return fetch(url)
        .then(toText)
        .then(content => {
          if (url.split('?')[0].indexOf('.css') !== -1) {
            content = content.replace(/\r+/g, '')
          }
          context.preload[name] = content
        })
    })
    return Promise.all(list)
  }
}
