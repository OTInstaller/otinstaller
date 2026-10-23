// New tools and releases for one input type (atom), for the types that have a landing page.
import type { APIRoute } from "astro";
import { feedMissing, inputFeed, serveFeed } from "../../../lib/feeds";
import { inputLabel } from "../../../lib/format";
import { INPUT_LANDING } from "../../../lib/landing";

export const GET: APIRoute = ({ params }) => {
  const type = params.type ?? "";
  return Object.hasOwn(INPUT_LANDING, type) ? serveFeed(() => inputFeed(type, inputLabel(type)), "atom") : feedMissing();
};
