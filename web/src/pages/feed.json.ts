// The registry-wide feed of what's new (json); /new shows the same events as a page.
import type { APIRoute } from "astro";
import { registryFeed, serveFeed } from "../lib/feeds";

export const GET: APIRoute = () => serveFeed(registryFeed, "json");
