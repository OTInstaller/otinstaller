// A publisher's feed (atom): releases, yanks and deprecations of its packages.
import type { APIRoute } from "astro";
import { feedMissing, publisherFeed, serveFeed } from "../../lib/feeds";
import { SLUG } from "../../lib/twins";

export const GET: APIRoute = ({ params }) => (SLUG.test(params.ns ?? "") ? serveFeed(() => publisherFeed(params.ns!), "atom") : feedMissing());
