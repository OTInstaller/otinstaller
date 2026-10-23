// /otlite/tools/<name>.md: an otlite tool's page as Markdown, for agents (content in lib/otlite.ts).
import type { APIRoute } from "astro";
import { markdownPage, markdownResponse } from "../../../lib/markdown";

export const GET: APIRoute = ({ params }) => {
  const page = markdownPage(`/otlite/tools/${params.name}`);
  return page ? markdownResponse(page) : new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
