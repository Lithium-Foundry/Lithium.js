// lithium client
// Load with <script type="module"> (or import it). It pulls in whatever
// proxy scripts it needs by itself, no extra <script> tags required.
//
//   import { init_lithium, navigate, back, on, config } from "/client/index.js"
//   await init_lithium({ searchEngine: "google" })
//   on("navigate", ({ url }) => console.log("now at", url))
//   navigate("example.com")

import * as net from "./net.js"
import { search_engines, build_search_url, search_origin } from "./search.js"
export { search_engines }

// the server injects this into your html (see server/index.js)
const server_config = () => (typeof window !== "undefined" && window.__LITHIUM_CONFIG__) || {}

const state = {
  proxy: null,
  transport: null,
  iface: null,
  ready: false,
  url: "", // last real URL the proxied page reported
  search_engine: "google",
  backend: null,
  ctx: null,
  poller: null,
  unsubs: [], // listeners created from init_lithium's options
  debug: false,
  header_policy: { ...net.DEFAULT_POLICY },
  network: [], // capped log of {method, url, status, ...}, see net.js
}
const NETWORK_LOG_CAP = 300

function dbg(...args) {
  if (state.debug) console.log("[lithium debug]", ...args)
}

// window errors are useful in debug mode but easy to miss otherwise; this
// listens once at module load and checks state.debug live, so it works
// across re-init without adding/removing listeners each time
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => { if (state.debug) console.error("[lithium debug] window error:", e.error ?? e.message) })
  window.addEventListener("unhandledrejection", (e) => { if (state.debug) console.error("[lithium debug] unhandled rejection:", e.reason) })
}

// ------------------------------------------------------------------ events --
// "ready"     () once init_lithium finished
// "navigate"  ({ url, previousUrl }) whenever the proxied page changes URL,
//             for every proxy
const listeners = new Map()

export function on(event, callback) {
  if (typeof callback !== "function") throw new TypeError("[lithium] on(event, callback): callback must be a function")
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(callback)
  return () => off(event, callback) // handy: const stop = on(...); stop()
}

export function off(event, callback) {
  listeners.get(event)?.delete(callback)
}

function emit(event, payload) {
  for (const callback of [...(listeners.get(event) ?? [])]) {
    try {
      callback(payload)
    } catch (err) {
      console.error(`[lithium] a "${event}" listener threw:`, err)
    }
  }
}

function report_url(url) {
  if (!url || url === state.url) return
  const previousUrl = state.url
  state.url = url
  emit("navigate", { url, previousUrl })
}

// ------------------------------------------------------------------ config --
// Read-only view of what the server started with, plus the search engine.
export const config = {
  get proxy() { return state.proxy ?? server_config().proxy ?? "ultraviolet" },
  get transport() { return state.transport ?? server_config().transport ?? "epoxy" },
  get interface() { return state.iface ?? server_config().interface ?? null },
  get ready() { return state.ready },
  get searchEngine() { return engine() },
  set searchEngine(name) {
    state.search_engine = name
    localStorage.setItem("engine", name)
  },
  get debug() { return state.debug },
  set debug(on) { state.debug = Boolean(on) },
  // read-only snapshot (deep enough that mutating it can't affect live state);
  // use set_header_policy() to change it live
  // read-only deep-enough snapshot (mutating it can't affect live state);
  // use set_header_policy() to change it live
  get headers() { return JSON.parse(JSON.stringify(state.header_policy)) },
}

// change the header policy without a full re-init (see net.js for what it can/can't do)
export function set_header_policy(policy = {}) {
  state.header_policy = { ...state.header_policy, ...policy }
  dbg("header policy set:", state.header_policy)
}

// [{ type: "fetch"|"xhr", method, url, status, ok, duration, ts, requestHeaders, responseHeaders, blockedRequestHeaders, blockedResponseHeaders }, ...]
// newest last, capped at 300 entries. See net.js for exactly what's covered.
export function network_log() {
  return [...state.network]
}

export function clear_network_log() {
  state.network.length = 0
}

// read every time so a settings page can change it on the fly
const engine = () => (typeof localStorage !== "undefined" && localStorage.getItem("engine")) || state.search_engine

// -------------------------------------------------------------------- setup --
// helper to load scripts dynamically
function load_script(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = src
    script.onload = resolve
    script.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(script)
  })
}

// The browser only says "script evaluation failed" when a service worker can't
// start, which is nearly always an importScripts() that 404'd. Check every
// file the worker imports and say which one is missing.
async function diagnose_sw(proxy) {
  const probe = async (path, note = "") => {
    try {
      const r = await fetch(path, { cache: "no-store" })
      console.error(`[lithium]   ${r.status} ${path} (${r.headers.get("content-type")}) ${note}`)
      return r
    } catch (e) {
      console.error(`[lithium]   failed ${path}: ${e.message}`)
    }
  }
  console.error("[lithium] the service worker failed to start, checking the files it imports:")
  if (proxy === "scramjet") {
    await probe("/controller/controller.sw.js")
    return
  }
  if (proxy !== "ultraviolet") {
    await probe(`/sw.js?proxy=${proxy}`)
    return
  }
  for (const p of ["/uv/uv.bundle.js", "/uv/uv.sw.js", "/uv/uv.handler.js", "/uv/uv.client.js"]) await probe(p)
  const cfg = await probe("/uv/uv.config.js")
  if (cfg?.ok) {
    // the paths the config itself points at are what actually get imported
    for (const m of (await cfg.text()).matchAll(/\b(handler|client|bundle|config|sw)\s*:\s*["']([^"']+)["']/g)) {
      await probe(m[2], `<- config.${m[1]}`)
    }
  }
}

async function register_sw(proxy) {
  let registration
  try {
    registration = await navigator.serviceWorker.register(`/sw.js?proxy=${proxy}`, {
      scope: "/",
      updateViaCache: "none",
    })
  } catch (err) {
    await diagnose_sw(proxy).catch(() => {})
    throw err
  }
  await navigator.serviceWorker.ready

  // wait until the worker actually controls this page, or the first
  // navigation can slip past it
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })
    )
  }
  return navigator.serviceWorker.controller ?? registration.active
}

function wisp_url() {
  return (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/"
}

// built-ins are bundled with the client, custom proxies name their own module
function load_backend(proxy, conf) {
  if (proxy === "ultraviolet") return import("./backends/ultraviolet.js")
  if (proxy === "scramjet") return import("./backends/scramjet.js")
  if (!conf.clientModule) throw new Error(`proxy "${proxy}" has no client module (was it registered with clientModule?)`)
  return import(conf.clientModule)
}

// the iframe pages are shown in: #proxyFrame if you have one, else we make it
// (create=false: just look, don't make one)
function get_iframe(create = true) {
  let iframe = document.getElementById("proxyFrame")
  if (!iframe && create) {
    iframe = document.createElement("iframe")
    iframe.id = "proxyFrame"
    iframe.style.cssText = "width:100%;height:100%;border:0"
    ;(document.getElementById("container") || document.body).appendChild(iframe)
  }
  // network log + header policy: reinstalled every real navigation, since a
  // new document means a new window. See net.js for what this can/can't see.
  if (iframe && !iframe.__lithiumNetBound) {
    iframe.__lithiumNetBound = true
    iframe.addEventListener("load", () => {
      try {
        net.install(iframe.contentWindow, {
          get_policy: () => state.header_policy,
          emit: (entry) => {
            state.network.push(entry)
            if (state.network.length > NETWORK_LOG_CAP) state.network.shift()
            emit("request", entry)
          },
          dbg,
          search_origin: () => search_origin(engine()),
        })
      } catch (err) {
        dbg("network hook install failed:", err)
      }
    })
  }
  return iframe
}

// init the thing
//   searchEngine  "google" | "duckduckgo"
//   onReady       () => void          (same as on("ready", ...))
//   onUrlChange   (url) => void       (same as on("navigate", ...), all proxies)
export async function init_lithium(cfg = {}) {
  const conf = server_config()
  // same defaults as the server
  const proxy = conf.proxy || "ultraviolet"
  const transport = conf.transport || "epoxy"
  const transport_url = conf.transportUrl || (proxy === "scramjet" ? `/${transport}/index.mjs` : `/bm/${transport}/index.mjs`)

  // re-init: forget the previous run
  for (const stop of state.unsubs) stop()
  state.unsubs = []
  clearInterval(state.poller)
  state.ready = false
  state.url = ""

  state.proxy = proxy
  state.transport = transport
  state.iface = conf.interface ?? null
  state.search_engine = cfg.searchEngine || "google"
  state.debug = Boolean(cfg.debug)
  state.header_policy = { ...net.DEFAULT_POLICY, ...(cfg.headers ?? {}) }
  if (cfg.onReady) state.unsubs.push(on("ready", () => cfg.onReady()))
  if (cfg.onUrlChange) state.unsubs.push(on("navigate", ({ url }) => cfg.onUrlChange(url)))

  // keep these around so your own ui can read them
  localStorage.setItem("proxy", proxy)
  localStorage.setItem("transport", transport)
  localStorage.setItem("engine", state.search_engine)
  console.log("[lithium] config:", { proxy, transport })
  dbg("init_lithium options:", cfg)
  dbg("header policy:", state.header_policy)

  try {
    dbg(`registering service worker for "${proxy}"`)
    const serviceworker = await register_sw(proxy)
    dbg("service worker ready, loading backend module")
    const backend = await load_backend(proxy, conf)
    const ctx = {
      proxy, transport, transport_url, serviceworker,
      wisp_url: wisp_url(),
      load_script,
      iframe: get_iframe,
      report_url,
      state: {}, // for the backend's own use
    }
    await backend.init(ctx)
    dbg("backend init complete")
    state.backend = backend
    state.ctx = ctx

    if (typeof backend.current_url === "function") {
      state.poller = setInterval(() => {
        try { report_url(backend.current_url(ctx)) } catch { /* frame not loaded yet */ }
      }, 500)
    }
  } catch (err) {
    console.error("[lithium] init failed:", err)
    if (state.debug) console.error("[lithium debug] full error:", err)
    throw err // don't pretend we're ready
  }

  state.ready = true
  emit("ready")
}

// ---------------------------------------------------------------- navigation --
async function go(url) {
  if (!state.ready) {
    console.error("[lithium] not ready yet, await init_lithium() first")
    return
  }
  get_iframe() // make sure it exists
  document.getElementById("container")?.classList.add("browsing")
  await state.backend.navigate(url, state.ctx)
}

// go somewhere on the internet: a URL, a domain, or a search
export function navigate(input) {
  const url = to_url(input, engine())
  dbg("navigate ->", url)
  return go(url)
}

// always a search, even if the text looks like a URL
export function search(query) {
  return go(search_url(query, engine()))
}

// the real URL of the page being shown ("" until something was loaded)
export function current_url() {
  return state.url
}

// history actions on the proxied page (works the same for every proxy)
function with_frame(action, fn) {
  try {
    const win = state.ready ? get_iframe(false)?.contentWindow : null
    if (win) fn(win)
  } catch (err) {
    console.error(`[lithium] ${action} failed:`, err)
  }
}
export const back = () => with_frame("back", (w) => w.history.back())
export const forward = () => with_frame("forward", (w) => w.history.forward())
export const reload = () => with_frame("reload", (w) => w.location.reload())

// ------------------------------------------------------------------ url utils --
// checks if its a url or some random junk
export function is_url(v = "") {
  v = v.trim()
  if (/^https?:\/\//i.test(v)) return true
  if (/\s/.test(v)) return false // "what is 3.14" is a search, not a url
  return (
    /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(v) || // example.com, a.b.co/path
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(v) // 192.168.1.1:8080
  )
}

// engine can be "google", "duckduckgo", or anything registered via
// search_engines.register()
export function search_url(query, engine = "google") {
  return build_search_url(query, engine)
}

// turn whatever was typed into a full url (or a search url)
export function to_url(input, engine = "google") {
  const val = input.trim()
  if (!is_url(val)) return search_url(val, engine)
  return /^https?:\/\//i.test(val) ? val : "https://" + val
}
