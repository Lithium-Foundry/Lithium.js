# Lithium.JS

![npm version](https://img.shields.io/npm/v/lithium.js?color=blue)
![npm downloads](https://img.shields.io/npm/dw/lithium.js)
![license](https://img.shields.io/badge/license-AGPL-purple?color=663366)
![node version](https://img.shields.io/badge/node-%3E%3D24.0-brightgreen)
![status](https://img.shields.io/badge/status-beta-orange)
![proxy engines](https://img.shields.io/badge/proxies-UV%20%7C%20Scramjet-purple)

A flexible web proxy framework to make your skid dream a reality.

## Features

- **Proxy registry**: Ultraviolet 3.x and Scramjet 2.x built in, `register()` your own
- **Transport registry**: Epoxy and Libcurl built in, each declaring which interface generation they speak
- **Compatibility validation at startup**: wrong package version or wrong transport generation throws a clear `LithiumError`, not a proxy that "sort of works" until it doesn't
- **`lithium doctor`**: one command to check your whole install
- **Events + history**: `on("navigate", ...)`, `back()`/`forward()`/`reload()`/`search()`, works the same for every proxy
- **Debug mode + network log**: `debug: true` for verbose tracing, `network_log()`/`on("request", ...)` for a devtools-lite view of the proxied page's `fetch`/XHR traffic
- **Header policy**: block/allow/override specific headers, spoof device fingerprint (`navigator`/`screen`), or bypass interception entirely with `passthrough` mode
- **Custom search engines**: register your own, with per-engine header overrides
- **Modular design**: clean separation of client and server code, custom backends are first-class

## Installation

```bash
npm install @nivalos/lithium.js
```

Scramjet 2.x is published under the `alpha` tag and Lithium pins the exact
versions it was built against, so you don't need to install Scramjet yourself.

## Quick Start

### Server Setup

```javascript
import { create_lithium_server } from "lithium.js";

const { server, port } = create_lithium_server({
  staticDir: 'public',
  port: 8080,
  proxy: 'ultraviolet',
  transport: 'epoxy'
})

server.listen(port, () => {
  console.log(`Lithium server running on http://localhost:${port}`)
})
```

** Ensure that you import it relative to your type in package.json.

`create_lithium_server` doesn't call `listen` for you, so you can attach your
own routes to the returned `app` first. Want to just try it? `npm start` runs
a ready-made server (`PROXY`, `TRANSPORT`, `PORT` and `STATIC_DIR` env vars).

### Client Setup

```javascript
import { init_lithium, navigate } from "/client/index.js";

await init_lithium({
  searchEngine: 'google',
  onReady: () => {
    console.log('Lithium is ready!')
  }
})

navigate('example.com')
navigate('search query')
```

When you are linking this script, make sure to add type="module".

`init_lithium` loads everything the chosen proxy needs (bare-mux, the Ultraviolet
bundle, the Scramjet controller, ...) by itself, so you no longer need extra
`<script>` tags. It rejects if setup fails, so wrap it in try/catch if you want
to show an error.

Pages are shown in an iframe. Give yours the id `proxyFrame` (and optionally put
it inside an element with id `container`), or Lithium will create one for you.

## Configuration

### Server Options

| Option               | Type       | Default         | Description                                                                    |
|-----------------------|-----------|-----------------|--------------------------------------------------------------------------------|
| staticDir             | string    | `'public'`      | Directory for static files (relative to `process.cwd()`, or absolute)          |
| port                  | number    | `8080`          | Port, returned from `create_lithium_server` for you to `listen` on             |
| proxy                 | string    | `'ultraviolet'` | Proxy: `'ultraviolet'`, `'scramjet'`, or one you registered (see below)        |
| transport             | string    | `'epoxy'`       | Transport: `'epoxy'`, `'libcurl'`, or one you registered                       |
| crossOriginIsolation  | boolean   | `true`          | Sends COOP/COEP headers when the proxy wants them (Scramjet does, UV doesn't)  |
| middleware            | function[]| `[]`            | `(req, res, next) => ...` functions, run before Lithium's own routes           |
| wisp                  | object    | `{}`            | Options merged into the shared wisp-js server, e.g. `{ allow_loopback_ips: true }` |
| strict                | boolean   | `true`          | `false`: warn about a package version mismatch instead of throwing             |
| quiet                 | boolean   | `false`         | Suppress the `[lithium] proxy + transport: ...` startup line                   |
| color                 | boolean   | *(auto)*        | Force-enable/disable colored console output (auto-detects a TTY otherwise)     |

An unknown `proxy`/`transport`, an incompatible pair, or a wrong package version throws a `LithiumError` (see below) instead of starting halfway broken.

### Client Options (`init_lithium(options)`)

| Option       | Type     | Default    | Description                                                          |
|--------------|----------|------------|------------------------------------------------------------------------|
| searchEngine | string   | `'google'` | `'google'` or `'duckduckgo'`                                          |
| onReady      | function | `null`     | Shorthand for `on("ready", ...)`                                     |
| onUrlChange  | function | `null`     | Shorthand for `on("navigate", ({url}) => ...)`, works for every proxy |
| debug        | boolean  | `false`    | Verbose `[lithium debug]` tracing, see "Debugging" below              |
| headers      | object   | see below  | Header policy for the proxied page's `fetch`/XHR, see "Headers" below |

## Usage Examples

### Navigate, search, and move around

```javascript
navigate('google.com')       // url or domain
navigate('https://example.com')
search('minecraft')          // always a search, even if it looks like a url

current_url()                // the real url currently shown
back(); forward(); reload()  // act on the proxied page's own history
```

### Listen for navigation

Works the same way for every proxy, built-in or custom:

```javascript
on("navigate", ({ url, previousUrl }) => console.log("now at", url))
on("ready", () => console.log("lithium is ready"))
```

### Check current config

```javascript
console.log(config.proxy, config.transport, config.interface, config.ready)
```

### Switch proxy/transport

```javascript
const { server, port } = create_lithium_server({ proxy: 'scramjet', transport: 'libcurl' })
```

## Registry (`proxies`, `transports`)

```javascript
import { proxies, transports, supports, get_compatibility } from "lithium.js"

proxies.list()                          // ["ultraviolet", "scramjet"]
transports.list()                       // ["epoxy", "libcurl"]
proxies.get("scramjet")                 // { name, interface, isolation, builtin, transports, packages }
supports("scramjet", "epoxy")           // true
get_compatibility("ultraviolet", "x")   // { supported: false, interface: "bare-mux", reason: "..." }
```

### Registering a custom backend

```javascript
proxies.register("my-proxy", {
  interface: "bare-mux",          // or "proxy-transports", or your own transport's interface name
  isolation: false,               // send COOP/COEP for this proxy?
  packages: [],                   // [{ name, major? }] checked at startup
  routes(app) { /* app.get(...) for anything special */ },
  mounts() { return [{ label: "my-proxy", url: "/my-proxy/", dir: someDir, files: ["bundle.js"] }] },
  serviceWorker: `...`,           // JS source; Lithium wraps it with skipWaiting/clients.claim
  clientModule: "/my-proxy/client.js", // browser module implementing init/navigate, see client/backends/*.js
})

transports.register("my-transport", {
  interfaces: { "bare-mux": { mount: "/my-transport/", dir: someDir, entry: "index.mjs" } },
})
```

`client/backends/ultraviolet.js` and `client/backends/scramjet.js` are the reference implementations of the client module contract (`init(ctx)`, `navigate(url, ctx)`, optional `current_url(ctx)`).

## Errors (`LithiumError`)

Every error Lithium throws on purpose has a `.code` you can branch on, plus `.details` with what would actually work:

```javascript
import { LithiumError } from "lithium.js"
try {
  create_lithium_server({ proxy: "ultraviolet", transport: "wisp" })
} catch (err) {
  if (err instanceof LithiumError) console.log(err.code, err.details)
  // "INCOMPATIBLE_TRANSPORT" { proxyInterface: "bare-mux", compatibleTransports: ["epoxy", "libcurl"], ... }
}
```

Codes: `UNKNOWN_PROXY`, `UNKNOWN_TRANSPORT`, `INCOMPATIBLE_TRANSPORT`, `PACKAGE_MISSING`, `PACKAGE_VERSION_MISMATCH`, `TRANSPORT_VERSION_MISMATCH`, `BACKEND_EXISTS`, `INVALID_BACKEND`, `INVALID_OPTION`.

## `lithium doctor`

```
npx lithium doctor [--proxy ultraviolet] [--transport epoxy] [--json] [--no-color]
```

Checks Node's version, every package's version (and, for epoxy/libcurl, which *generation* is installed — this is the check that would have caught the original UV startup bug), that every file each backend needs is actually on disk, and whether the proxy/transport pair you're about to run is compatible. Exits `1` if it finds a problem, so it's CI-friendly. Colored automatically in a terminal, plain when piped, or force with `--no-color`/`NO_COLOR=1`/`FORCE_COLOR=1`.

## Debugging

```javascript
await init_lithium({ debug: true })       // or: config.debug = true, any time
```

Traces every step (script load order, service worker registration, backend init, navigation targets) as `[lithium debug]` lines, and turns on `window.onerror`/`unhandledrejection` logging. Off by default since it's noisy.

## Headers

Lithium's Node server never sees the proxied site's raw HTTP (that goes browser → service worker → the wisp tunnel → the real site, as bytes, not parsed HTTP), so header control happens client-side, on the proxied page's own `fetch`/`XHR` calls:

```javascript
await init_lithium({
  headers: {
    mode: "filter",                    // "filter" (default) or "passthrough" (touch nothing)
    block: ["x-frame-options"],        // stripped from requests AND responses, case-insensitive
    allow: null,                       // if an array, ONLY these header names survive
    set: { "x-custom": "value" },      // added/overridden on outgoing requests
    searchEngineHeaders: { "x-a": "b" }, // extra `set` overrides, ONLY on requests to the current search engine's origin
    referrer: "https://example.com/",  // passed to fetch()'s own `referrer` option (Referer can't be set via headers at all)
    device: {                          // spoofs navigator/screen on the proxied page, see "Device spoofing" below
      userAgent: "Mozilla/5.0 (...) Custom/1.0",
      platform: "Win32",
    },
  },
})
set_header_policy({ mode: "passthrough" })  // change any of this any time, no re-init needed
```

**Scope, honestly:** this rebuilds the `Response` object `fetch()` hands to the page, so it's real for anything the page's own JS reads. `XMLHttpRequest` traffic is logged but the policy isn't enforced on it. `<img>`, `<script src>`, `<link>`, and CSS loads never go through JS at all, so they're invisible to this — there's no hook point for them at this layer.

**A real browser restriction, not a Lithium limitation:** a set of header names — `Cookie`, `Host`, `Origin`, `Connection`, anything starting with `Sec-`/`Proxy-`, and a few others — are "forbidden request headers" per the Fetch spec. No page JS anywhere can set them; the browser silently drops them when it builds the real request. `Referer` is on that list too, which is why it's handled separately via `referrer` above rather than through `set`/`block`/`allow` (put it in `set.referer` if that's more convenient — Lithium notices and routes it to the right place for you). `User-Agent` isn't spec-forbidden anymore, but Chrome still silently drops it from `fetch()` regardless (a long-standing Chromium quirk); Firefox honors it. `network_log()` entries include a `caveats` note whenever a header you configured falls into one of these categories, so you're not left guessing why it didn't take.

### Device spoofing

The `device` option overrides `navigator`/`screen` properties (`userAgent`, `platform`, `vendor`, `language`, `languages`, `maxTouchPoints`, `hardwareConcurrency`, `deviceMemory`, `userAgentData`, `screen: { width, height, ... }`) on the proxied page, so the *site's own JavaScript* — feature detection, analytics, fingerprinting — sees a different device. This is unrestricted (none of the forbidden-header rules above apply to JS properties), but it only fools client-side JS, not a server reading real HTTP headers, and only for reads that happen after this installs (same per-navigation timing caveat as everything else in this section).

## Custom search engines

```javascript
import { search_engines } from "lithium.js" // or a client-only import in the browser

search_engines.register("bing", (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`)
await init_lithium({ searchEngine: "bing" })   // or: config.searchEngine = "bing" any time
```

`search()`/`navigate()` with a non-URL query, and the `searchEngineHeaders` scoping above, all use whichever engine is currently set. An unregistered name silently falls back to Google rather than breaking navigation.

## Network log

```javascript
on("request", (entry) => console.log(entry))   // { method, url, status, duration, requestHeaders, responseHeaders, blockedRequestHeaders, blockedResponseHeaders, ... }
network_log()          // everything captured so far (capped at 300 entries)
clear_network_log()
```

Same scope as Headers above: `fetch`/`XHR` only, reinstalled fresh on every real navigation (a new page is a new `window`), and only requests made after that page finishes loading. The test app (`lithium-test/`) has a "Network" panel built on this.

## Colored output

`server/color.js` is a tiny zero-dependency ANSI helper (`color.green(...)`, etc.) used for `lithium doctor` and the server's own startup/warning/error lines. It auto-detects a TTY and respects `NO_COLOR`/`FORCE_COLOR`; pass `color: false` to `create_lithium_server` or `--no-color` to the CLI to force it off.

## How the transports work (read this if you touch package.json)

The transport packages come in two generations that are **not** interchangeable:

| Proxy            | Interface          | epoxy | libcurl |
|------------------|--------------------|-------|---------|
| Ultraviolet 3.x  | bare-mux           | ^2    | ^1      |
| Scramjet 2.x     | proxy-transports   | ^3    | ^2      |

Mixing them can look like it works and then fail on specific sites. Lithium
installs both: the normal `@mercuryworkshop/epoxy-transport` and
`@mercuryworkshop/libcurl-transport` are the Scramjet generation, and the
`epoxy-transport-bm` / `libcurl-transport-bm` entries in `package.json` are npm
aliases for the bare-mux generation that Ultraviolet uses. Don't "clean up" the
aliases or bump their versions to match.

Files are served at:

| Path                         | What                                   |
|------------------------------|----------------------------------------|
| `/uv/`, `/baremux/`          | Ultraviolet + bare-mux (`/uv/uv.config.js` is generated by Lithium; proxied pages live under `/service/`) |
| `/bm/epoxy/`, `/bm/libcurl/` | transport for Ultraviolet              |
| `/scram/`, `/controller/`, `/utils/` | Scramjet, its controller, its plugins |
| `/epoxy/`, `/libcurl/`       | transport for Scramjet                 |
| `/wisp/`                     | wisp websocket                         |

## Troubleshooting

### Start here
Run `npx lithium doctor` first — it checks Node's version, every package version (including which transport *generation* is installed, the single most common source of "it starts then breaks on random sites"), that every file each backend needs is on disk, and whether your proxy/transport pair is compatible.

### Config not loading
- Check browser console for `[lithium] config:`
- Ensure your HTML is a `.html` file in `staticDir` (config is injected into `<head>` when the file is served)

### Proxy not working
- Check if service worker registered: `navigator.serviceWorker.controller`
- Verify proxy files are accessible in Network tab
- Look for errors in console, and for `[lithium] ...: expected "..." in ...` lines in the server log

### Scramjet: some sites break, or a warning about cross-origin isolation
- `crossOriginIsolated` must be `true` in the browser console (needs `localhost` or https)
- If your own page loads third-party fonts/images and they got blocked, either serve them with CORS/CORP headers or set `crossOriginIsolation: false` (some proxied sites will then break)

### Ultraviolet: "ServiceWorker script evaluation failed"
- The browser gives no detail, so Lithium's client logs the status of every file the worker imports (look for `[lithium]   404 ...` lines). A 404 next to `<- config.sw` (or `handler`/`bundle`) means the `uv.config.js` being served isn't Lithium's generated one, e.g. a stale copy in your `staticDir` or a caching layer.

### Transport issues
- Ultraviolet: ensure the BareMux worker is accessible at `/baremux/worker.js`
- Check WISP connection in DevTools (`/wisp/`)
- Verify transport files are served (see the table above)

### A site looks broken and you don't know why
- Turn on `init_lithium({ debug: true })` and reload — see "Debugging" above
- Open `network_log()` (or the test app's "Network" panel) and check for unexpected `status: 0` entries (the request threw) or headers you're blocking that the site actually needed
- If you're blocking headers, try `set_header_policy({ mode: "passthrough" })` to rule that out first

## Copyright notice
```
    sythora/Platinum: A flexible web proxy framework to make your skid dream a reality.
    Copyright (C) 2026 sythora & nivalos

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

Lithium.js is an updated fork of Platinum.js, this fork updates dependencies, and is the new framework for Lithium (a fork of Utopia)
