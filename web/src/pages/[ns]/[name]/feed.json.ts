// A tool's releases as a feed (json), each with its release notes.
import type { APIRoute } from "astro";
import { feedMissing, serveFeed, toolFeed } from "../../../lib/feeds";
import { SLUG } from "../../../lib/twins";

export const GET: APIRoute = ({ params }) =>
  SLUG.test(params.ns ?? "") && SLUG.test(params.name ?? "") ? serveFeed(() => toolFeed(params.ns!, params.name!), "json") : feedMissing();
