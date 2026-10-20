// Loading a tool for its pages: redirects for moved packages and guides, 404 for unknown ones, 410 for removed ones.
import type { AstroGlobal } from "astro";
import { ApiError, apiOrNull, type ToolDetail } from "./api";

export type Loaded = { tool: ToolDetail; hasDocs: boolean } | { response: Response };

export async function loadTool(Astro: AstroGlobal, rest = ""): Promise<Loaded> {
  const { ns, name } = Astro.params as { ns: string; name: string };
  let tool: ToolDetail | null;
  try {
    tool = await apiOrNull<ToolDetail>(`/tools/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`);
  } catch (e) {
    // Removed packages answer 410 Gone with why; the page says so with the same status.
    if (e instanceof ApiError && e.status === 410) return { response: await removedPage(Astro, e.message) };
    throw e;
  }
  if (!tool) return { response: await Astro.rewrite("/404") };
  // Transferred packages answer at their old address with a permanent redirect; guides live under /guides.
  if (tool.moved_to) return { response: Astro.redirect(`/${tool.moved_to}${rest}`, 301) };
  if (tool.kind === "guide") return { response: Astro.redirect(`/guides/${tool.namespace}/${tool.name}`, 301) };
  return { tool, hasDocs: !!tool.manifest.docs?.nav?.length };
}

async function removedPage(Astro: AstroGlobal, message: string): Promise<Response> {
  const res = await Astro.rewrite(`/removed?why=${encodeURIComponent(message)}`);
  return new Response(res.body, { status: 410, headers: res.headers });
}
