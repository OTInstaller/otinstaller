// The manifest JSON Schema, served from spec/ so editors can autocomplete otinstaller.yaml.
import type { APIRoute } from "astro";
import schema from "../../../../spec/schema/v1.json";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(schema, null, 2), { headers: { "Content-Type": "application/schema+json", "Access-Control-Allow-Origin": "*" } });
