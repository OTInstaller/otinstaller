// Content negotiation for docs and policy pages: `Accept: text/markdown` gets the page's Markdown twin.
import { defineMiddleware } from "astro:middleware";
import { markdownPage, markdownResponse, prefersMarkdown } from "./lib/markdown";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname } = ctx.url;
  const page = (ctx.request.method === "GET" || ctx.request.method === "HEAD") && !pathname.endsWith(".md") ? markdownPage(pathname) : null;
  if (!page) return next();
  // The Markdown answer is private: shared caches (Cloudflare's included) don't key on Vary, so a public copy
  // could be handed to a browser asking for HTML on the same URL. The .md URLs are the cacheable form.
  if (prefersMarkdown(ctx.request.headers.get("accept"))) return markdownResponse(page, true);
  const res = await next();
  try {
    res.headers.append("Vary", "Accept");
  } catch {
    // Immutable headers (a redirect or a static response): leave it as it is.
  }
  return res;
});
