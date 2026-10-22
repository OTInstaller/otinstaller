// /agents.md: the agents page as Markdown, written for agents (content in lib/agents.ts).
import type { APIRoute } from "astro";
import { markdownPage, markdownResponse } from "../lib/markdown";

export const GET: APIRoute = () => markdownResponse(markdownPage("/agents")!);
