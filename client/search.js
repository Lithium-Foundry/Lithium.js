// Search engine registry. Built-ins are "google" and "duckduckgo"; register
// your own with a name and a function that turns a query into a URL.
//   search_engines.register("bing", (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`)
//   set_header_policy set the default via init_lithium({ searchEngine: "bing" })

const engines = new Map([
  ["google", (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`],
  ["duckduckgo", (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`],
])

export const search_engines = {
  list: () => [...engines.keys()],
  has: (name) => engines.has(name),
  register(name, url_builder) {
    if (typeof name !== "string" || !name) throw new TypeError('search_engines.register(name, urlBuilder): name must be a non-empty string')
    if (typeof url_builder !== "function") throw new TypeError(`search_engines.register("${name}", urlBuilder): urlBuilder must be a function (query) => url`)
    engines.set(name, url_builder)
  },
}

// falls back to "google" if the name isn't registered (never throws on lookup;
// registering a bad one throws above, but using an unknown name shouldn't
// break a running page over a typo)
export function build_search_url(query, name) {
  const build = engines.get(name) ?? engines.get("google")
  return build(String(query).trim())
}

// the origin a search actually goes to, used to scope search-engine-only
// header overrides (see net.js). null if the engine's URL is malformed.
export function search_origin(name) {
  try {
    return new URL(build_search_url("x", name)).origin
  } catch {
    return null
  }
}
