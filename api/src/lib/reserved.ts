// Namespace names the registry never gives out: the website's own top-level sections. A publisher called "community"
// or "requests" would otherwise have its page hidden behind the site's. New namespaces with one of these names get the
// same "-gh" or "-gl" suffix as a name that is taken. The site's lib/reserved.test.ts checks its list is covered.
export const RESERVED_NAMESPACES = new Set([
  "docs", "policy", "schema", "admin", "category", "input", "settings", "transfers", "guides", "search", "import", "feedback",
  "dashboard", "removed", "publish", "tour", "otlite", "agents", "new", "404", "500", "learn", "community", "unsubscribe",
  "requests", "people", "submissions", "changelog", "blog", "api", "mcp", "feed", "login", "logout", "about", "notifications",
  "start",
]);

// A namespace made on the registry itself (`ot namespace create`, direct.ts) can't take these either: names that pass
// for the registry's own (its brand, the mirror's private/ prefix, API and host prefixes). GitHub and GitLab accounts
// with one of these names still get their own namespace, as before.
export const REGISTRY_RESERVED = new Set(["osintverse", "otinstaller", "private", "profile", "v2", "www"]);
