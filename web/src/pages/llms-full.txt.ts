// /llms-full.txt: every docs page, then every Markdown policy page, in one plain-text file for agents.
import type { APIRoute } from "astro";
import { DOC_PAGES, POLICY_PAGES, renderMarkdown } from "../lib/markdown";

// Built once per Worker: the pages are bundled, so the text only changes on deploy.
const BODY = [...DOC_PAGES, ...POLICY_PAGES].map((p) => renderMarkdown(p, true)).join("\n---\n\n");

export const GET: APIRoute = () =>
  new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
