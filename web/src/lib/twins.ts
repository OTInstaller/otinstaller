// Serving the Markdown twins of tool and guide pages: loads from the API and answers with the right status and caching.
import { api, ApiError, apiOrNull, SITE_URL, type ActivityEvent, type GuideDetail, type Namespace, type Page, type ToolDetail } from "./api";
import { cacheControl } from "./page";
import { guidePageMarkdown, guidePageUrl, problemMarkdown, toolMarkdown } from "./tool-markdown";
import { profileMarkdown } from "./profile";

/** A namespace or package name (the manifest's slug rule); anything else is not a package URL. */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** First path segments that are site sections, not namespaces (reserved.test.ts checks every page is listed). */
export const RESERVED = new Set([
  "docs", "policy", "schema", "admin", "category", "input", "settings", "transfers", "guides", "search", "import", "feedback",
  "dashboard", "removed", "publish", "tour", "otlite", "agents", "new", "404", "500",
]);

/** A Markdown response. Negotiated ones answer an HTML URL by Accept header, so no shared cache may keep them. */
function md(body: string, status: number, seconds: number, canonical: string | null, negotiated: boolean): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": seconds <= 0 ? "no-store" : negotiated ? `private, max-age=${Math.min(seconds, 300)}` : cacheControl(seconds),
  };
  if (canonical) headers.Link = `<${canonical}>; rel="canonical"`;
  if (negotiated) headers.Vary = "Accept";
  return new Response(body, { status, headers });
}

function redirect(to: string, negotiated: boolean): Response {
  const headers: Record<string, string> = { Location: to, "Cache-Control": negotiated ? "private, max-age=60" : cacheControl(60) };
  if (negotiated) headers.Vary = "Accept";
  return new Response(null, { status: 301, headers });
}

/** Loads from the API: the value, null for a 404, or a ready answer for a 410 or the registry being down. */
async function load<T>(path: string, what: string, negotiated: boolean): Promise<T | null | Response> {
  try {
    return await apiOrNull<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) return md(problemMarkdown(410, what, e.message), 410, 60, null, negotiated);
    return md(problemMarkdown(503, what), 503, 0, null, negotiated);
  }
}

/** /<ns>/<name>.md, or /<ns>/<name> with `Accept: text/markdown`. Cached like the HTML tool page (60 s). */
export async function toolTwin(ns: string, name: string, negotiated: boolean): Promise<Response> {
  const ref = `${ns}/${name}`;
  const t = await load<ToolDetail>(`/tools/${ref}`, ref, negotiated);
  if (t instanceof Response) return t;
  if (!t) return md(problemMarkdown(404, ref), 404, 60, null, negotiated);
  if (t.moved_to) return redirect(`/${t.moved_to}${negotiated ? "" : ".md"}`, negotiated);
  return md(toolMarkdown(t), 200, 60, `${SITE_URL}/${ref}`, negotiated);
}

/** /guides/<ns>/<name>[/<page>].md (the first page without one), or the HTML URL with `Accept: text/markdown`. */
export async function guideTwin(ns: string, name: string, want: string, pinned: string | null, negotiated: boolean): Promise<Response> {
  const ref = `${ns}/${name}`;
  const g = await load<GuideDetail>(`/guides/${ref}${pinned ? `/${encodeURIComponent(pinned)}` : ""}`, ref, negotiated);
  if (g instanceof Response) return g;
  if (!g) return md(problemMarkdown(404, `guide ${ref}${pinned ? `@${pinned}` : ""}`), 404, 60, null, negotiated);
  if (g.kind !== "guide") return redirect(`/${g.namespace}/${g.name}${negotiated ? "" : ".md"}`, negotiated);
  const version = g.version === g.latest_version ? undefined : g.version;
  const seconds = version ? 3600 : 600;
  if (!g.nav.length) return md(`# ${g.title ?? ref}\n\n${g.summary}\n\nThis guide has no pages yet.\n`, 200, seconds, `${SITE_URL}/guides/${ref}`, negotiated);
  const which = want ? want.split("/").map(encodeURIComponent).join("/") : "1";
  const page = await load<Page>(`/guides/${ref}/${encodeURIComponent(g.version)}/pages/${which}?format=md`, `${ref} page ${want}`, negotiated);
  if (page instanceof Response) return page;
  if (!page) return md(problemMarkdown(404, `page ${want} in ${ref}`), 404, 60, null, negotiated);
  return md(guidePageMarkdown(page, version), 200, seconds, guidePageUrl(ref, page.path, version), negotiated);
}

/** /<ns>.md, or /<ns> with `Accept: text/markdown`: a publisher's profile. Cached like the HTML page (300 s). */
export async function profileTwin(ns: string, negotiated: boolean): Promise<Response> {
  const n = await load<Namespace>(`/namespaces/${encodeURIComponent(ns)}`, `publisher ${ns}`, negotiated);
  if (n instanceof Response) return n;
  if (!n) return md(problemMarkdown(404, `publisher ${ns}`), 404, 60, null, negotiated);
  const activity = n.status === "pending_review" ? [] : await api<{ events: ActivityEvent[] }>(`/namespaces/${encodeURIComponent(ns)}/activity?limit=10`).then((r) => r.events, () => []);
  return md(profileMarkdown(n, activity), 200, 300, `${SITE_URL}/${n.name}`, negotiated);
}
