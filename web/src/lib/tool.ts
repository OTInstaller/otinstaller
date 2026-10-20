// Loading a tool for its pages: redirects for moved packages and guides, 404 for unknown ones.
import type { AstroGlobal } from "astro";
import { apiOrNull, type ToolDetail } from "./api";

export type Loaded = { tool: ToolDetail; hasDocs: boolean } | { response: Response };

export async function loadTool(Astro: AstroGlobal, rest = ""): Promise<Loaded> {
  const { ns, name } = Astro.params as { ns: string; name: string };
  const tool = await apiOrNull<ToolDetail>(`/tools/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`);
  if (!tool) return { response: await Astro.rewrite("/404") };
  // Transferred packages answer at their old address with a permanent redirect; guides live under /guides.
  if (tool.moved_to) return { response: Astro.redirect(`/${tool.moved_to}${rest}`, 301) };
  if (tool.kind === "guide") return { response: Astro.redirect(`/guides/${tool.namespace}/${tool.name}`, 301) };
  return { tool, hasDocs: !!tool.manifest.docs?.nav?.length };
}
