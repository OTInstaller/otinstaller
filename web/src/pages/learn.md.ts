// /learn.md: the learn page as Markdown (content in lib/learn.ts).
import type { APIRoute } from "astro";
import { markdownPage, markdownResponse } from "../lib/markdown";

export const GET: APIRoute = () => markdownResponse(markdownPage("/learn")!);
