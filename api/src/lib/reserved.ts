// Namespace names the registry never gives out: the website's own top-level sections. A publisher called "community"
// or "requests" would otherwise have its page hidden behind the site's. New namespaces with one of these names get the
// same "-gh" or "-gl" suffix as a name that is taken. web/src/lib/reserved.test.ts checks the site's list is covered.
export const RESERVED_NAMESPACES = new Set([
  "docs", "policy", "schema", "admin", "category", "input", "settings", "transfers", "guides", "search", "import", "feedback",
  "dashboard", "removed", "publish", "tour", "otlite", "agents", "new", "404", "500", "learn", "community", "unsubscribe",
  "requests", "people", "submissions", "api", "mcp", "feed", "login", "logout", "about",
]);
