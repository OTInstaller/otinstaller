// /docs.md: the docs index as Markdown (also served at /docs/index.md).
import type { APIRoute } from "astro";
import { markdownPage, markdownResponse } from "../lib/markdown";

export const GET: APIRoute = () => markdownResponse(markdownPage("/docs")!);
