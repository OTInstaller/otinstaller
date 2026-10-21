// /docs/<page>.md: the docs page's Markdown source, frontmatter stripped, with its title and description on top.
import type { APIRoute } from "astro";
import { markdownPage, markdownResponse } from "../../lib/markdown";

export const GET: APIRoute = ({ params }) => {
  const page = markdownPage(`/docs/${params.page}`);
  return page ? markdownResponse(page) : new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
