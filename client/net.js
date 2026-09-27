// Best-effort network visibility + header policy for the proxied page.
//
// SCOPE, HONESTLY: Lithium's Node server never sees the proxied site's raw
// HTTP traffic (that goes browser -> service worker -> wisp tunnel -> the
// real site, as bytes, not parsed HTTP). So this works client-side instead:
// it's installed on the proxied iframe's window (same-origin, since that's
// how UV/Scramjet serve proxied pages) and wraps fetch()/XMLHttpRequest.
//   - fetch(): full control over request headers going out and the Response
//     the page's own code sees coming back.
//   - XMLHttpRequest: observed only (logged), the header policy is NOT
//     enforced on it — rebuilding a native XHR's headers isn't practical.
//   - Anything that isn't fetch/XHR (<img>, <script src>, <link>, CSS,
//     etc.) is invisible here entirely.
//   - Only requests made AFTER this installs are seen. It installs on the
//     iframe's "load" event, so very early/synchronous requests on that
//     page can be missed.
//
// A real browser restriction this can't route around: a set of header names
// ("forbidden request headers" in the Fetch spec — Cookie, Host, Origin,
// Connection, and anything starting with Sec-/Proxy-, among others) can't be
// set from page JS at all; the browser silently drops them when it builds
// the actual request, no matter what's in the Headers object handed to
// fetch(). Referer is spec-forbidden the same way, but fetch() has a
// dedicated `referrer` option that DOES work, so that one's routed there
// instead. User-Agent is no longer spec-forbidden, but Chrome still silently
// drops it from fetch() requests regardless (a long-standing Chromium
// quirk); Firefox honors it. See is_unforgeable_header()/header_set_caveat().

export const DEFAULT_POLICY = {
  mode: "filter",
  block: [],
  allow: null,
  set: {}, // headers to add/override on outgoing requests (subject to the browser restrictions above)
  searchEngineHeaders: {}, // extra overrides, applied ONLY when the request's origin is the current search engine's
  device: null, // { userAgent, platform, vendor, language, languages, maxTouchPoints, hardwareConcurrency, deviceMemory, userAgentData, screen } spoofed on navigator/screen
  referrer: undefined, // passed straight to fetch()'s `referrer` option
  referrerPolicy: undefined,
}

const UNFORGEABLE_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive",
  "origin", "permissions-policy", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
])

// true for header names the browser will silently refuse to send from page
// JS no matter what Lithium does — see the file header for why
export function is_unforgeable_header(name) {
  const lk = String(name).toLowerCase()
  return UNFORGEABLE_HEADERS.has(lk) || lk.startsWith("sec-") || lk.startsWith("proxy-")
}

// a one-line explanation for a header name in a `set`/`searchEngineHeaders`
// map, or null if there's nothing special to say about it
export function header_set_caveat(name) {
  const lk = String(name).toLowerCase()
  if (lk === "user-agent") return "not spec-forbidden, but Chrome silently drops it from fetch() requests anyway (Chromium bug 571722); Firefox honors it"
  if (lk === "referer" || lk === "referrer") return "Referer can't be set via headers at all; use policy.referrer instead (Lithium routes set.referer there for you)"
  if (is_unforgeable_header(lk)) return "forbidden by the Fetch spec — the browser drops it silently, there's no workaround from page JS"
  return null
}

// mode: "passthrough" -> do nothing (headers pass exactly as the proxy
//       already delivered them, including ignoring set/searchEngineHeaders);
//       "filter" -> apply block/allow, then (for request headers only) set/searchEngineHeaders
// direction: "request" | "response" — set/searchEngineHeaders/referrer only make sense for
//            outgoing requests (they're about how WE identify ourselves), not responses
// search_engine_match: whether this request's origin is the current search engine's,
//                       enabling searchEngineHeaders on top of set
export function apply_policy(headers, policy, { direction = "request", search_engine_match = false } = {}) {
  if (policy.mode === "passthrough") return { headers, blocked: [], overridden: [], caveats: [], referrer: undefined }

  const out = new Headers()
  const blocked = []
  const block = new Set((policy.block ?? []).map((h) => h.toLowerCase()))
  const allow = policy.allow ? new Set(policy.allow.map((h) => h.toLowerCase())) : null
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase()
    if (block.has(lk) || (allow && !allow.has(lk))) {
      blocked.push(k)
      continue
    }
    out.append(k, v)
  }

  if (direction !== "request") return { headers: out, blocked, overridden: [], caveats: [], referrer: undefined }

  const overrides = { ...(policy.set ?? {}), ...(search_engine_match ? (policy.searchEngineHeaders ?? {}) : {}) }
  const overridden = []
  const caveats = []
  let referrer = policy.referrer
  for (const [name, value] of Object.entries(overrides)) {
    const lk = name.toLowerCase()
    if (lk === "referer" || lk === "referrer") {
      referrer ??= value // an explicit policy.referrer still wins over one smuggled in via `set`
      caveats.push({ name, note: header_set_caveat(name) })
      continue // don't bother putting a header in that fetch() would drop anyway
    }
    out.set(name, value)
    overridden.push(name)
    const note = header_set_caveat(name)
    if (note) caveats.push({ name, note })
  }
  return { headers: out, blocked, overridden, caveats, referrer }
}

// Overrides properties of navigator/screen on the proxied window so the
// SITE'S OWN JS (feature detection, analytics, fingerprinting) sees a
// different device. This is unrestricted (no Fetch-spec forbidden list to
// fight), unlike request headers — but it only fools JS, not a server that
// inspects real HTTP headers, and it only takes effect for code that reads
// these properties AFTER this installs (see the file header).
// Returns which property names were successfully overridden.
export function apply_device_profile(win, device) {
  if (!device || !win?.navigator) return []
  const applied = []
  const nav = win.navigator
  const simple = ["userAgent", "platform", "vendor", "language", "languages", "maxTouchPoints", "hardwareConcurrency", "deviceMemory"]
  for (const key of simple) {
    if (device[key] === undefined) continue
    try {
      Object.defineProperty(nav, key, { get: () => device[key], configurable: true })
      applied.push(key)
    } catch {}
  }
  if (device.userAgentData) {
    const uad = device.userAgentData
    try {
      Object.defineProperty(nav, "userAgentData", {
        configurable: true,
        get: () => ({
          brands: uad.brands ?? [],
          mobile: Boolean(uad.mobile),
          platform: uad.platform ?? "",
          toJSON: () => ({ brands: uad.brands ?? [], mobile: Boolean(uad.mobile), platform: uad.platform ?? "" }),
          getHighEntropyValues: async (hints) =>
            Object.fromEntries((hints ?? []).map((h) => [h, h in uad ? uad[h] : h === "brands" ? uad.brands ?? [] : h === "mobile" ? Boolean(uad.mobile) : h === "platform" ? uad.platform ?? "" : null])),
        }),
      })
      applied.push("userAgentData")
    } catch {}
  }
  if (device.screen && win.screen) {
    for (const [key, value] of Object.entries(device.screen)) {
      try {
        Object.defineProperty(win.screen, key, { get: () => value, configurable: true })
        applied.push(`screen.${key}`)
      } catch {}
    }
  }
  return applied
}

const headers_to_object = (headers) => Object.fromEntries(headers.entries())

// win: the proxied iframe's contentWindow
//   get_policy()    -> current policy (read live, so changes apply mid-session)
//   emit(entry)     -> called once per completed request
//   dbg(...)        -> debug logger
//   search_origin() -> the current search engine's origin, or null (for searchEngineHeaders scoping)
export function install(win, { get_policy, emit, dbg = () => {}, search_origin = () => null }) {
  if (!win || win.__lithiumNetHooked) return
  win.__lithiumNetHooked = true

  const initial_policy = get_policy()
  if (initial_policy.device) {
    const applied = apply_device_profile(win, initial_policy.device)
    dbg(`device profile applied: ${applied.length ? applied.join(", ") : "(nothing — properties weren't configurable here)"}`)
  }

  const orig_fetch = win.fetch?.bind(win)
  if (orig_fetch) {
    win.fetch = async (input, init = {}) => {
      const policy = get_policy()
      const url = typeof input === "string" ? input : input.url
      const method = (init.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase()
      const started = win.performance?.now?.() ?? Date.now()
      const origin = search_origin()
      const is_search_request = Boolean(origin) && url.startsWith(origin)

      let req_headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined) || {})
      const req_result = apply_policy(req_headers, policy, { direction: "request", search_engine_match: is_search_request })
      req_headers = req_result.headers
      if (req_result.blocked.length) dbg(`blocked request headers on ${url}: ${req_result.blocked.join(", ")}`)
      for (const c of req_result.caveats) if (c.note) dbg(`request header "${c.name}" on ${url}: ${c.note}`)

      const finish = (fields) =>
        emit({
          type: "fetch", method, url, ts: Date.now(), duration: Math.round((win.performance?.now?.() ?? Date.now()) - started),
          requestHeaders: headers_to_object(req_headers), blockedRequestHeaders: req_result.blocked, blockedResponseHeaders: [], responseHeaders: null,
          ...fields,
        })

      const fetch_init = { ...init, headers: req_headers }
      if (req_result.referrer !== undefined) fetch_init.referrer = req_result.referrer
      if (policy.referrerPolicy) fetch_init.referrerPolicy = policy.referrerPolicy

      let response
      try {
        response = await orig_fetch(input instanceof Request ? new Request(input, { headers: req_headers }) : input, fetch_init)
      } catch (err) {
        finish({ status: 0, ok: false, error: err.message })
        throw err
      }

      if (policy.mode === "passthrough") {
        finish({ status: response.status, ok: response.ok, responseHeaders: headers_to_object(response.headers) })
        return response
      }
      const res_result = apply_policy(response.headers, policy, { direction: "response" })
      if (res_result.blocked.length) dbg(`blocked response headers on ${url}: ${res_result.blocked.join(", ")}`)
      finish({ status: response.status, ok: response.ok, responseHeaders: headers_to_object(res_result.headers), blockedResponseHeaders: res_result.blocked })
      if (!res_result.blocked.length) return response
      const body = await response.clone().blob()
      return new Response(body, { status: response.status, statusText: response.statusText, headers: res_result.headers })
    }
  }

  const OrigXHR = win.XMLHttpRequest
  if (OrigXHR) {
    win.XMLHttpRequest = class extends OrigXHR {
      open(method, url, ...rest) {
        this.__lithium = { method, url, started: win.performance?.now?.() ?? Date.now() }
        return super.open(method, url, ...rest)
      }
      send(...args) {
        this.addEventListener("loadend", () => {
          const info = this.__lithium || {}
          let responseHeaders = null
          try {
            responseHeaders = Object.fromEntries(
              this.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
            )
          } catch {}
          emit({
            type: "xhr", method: info.method || "GET", url: info.url || "", status: this.status, ok: this.status >= 200 && this.status < 400,
            duration: Math.round((win.performance?.now?.() ?? Date.now()) - (info.started ?? 0)), ts: Date.now(),
            requestHeaders: null, responseHeaders, blockedRequestHeaders: [], blockedResponseHeaders: [],
            note: "XHR is observed only, header policy isn't enforced on it",
          })
        })
        return super.send(...args)
      }
    }
  }
}
