// The result envelope, run-all summary and error JSON Schemas, served from spec/ like the manifest schema.
import type { APIRoute, GetStaticPaths } from "astro";
import envelope from "../../../../spec/schema/envelope-v1.json";
import runAll from "../../../../spec/schema/run-all-v1.json";
import error from "../../../../spec/schema/error-v1.json";

export const prerender = true;

const SCHEMAS: Record<string, unknown> = { "envelope-v1": envelope, "run-all-v1": runAll, "error-v1": error };

export const getStaticPaths = (() => Object.keys(SCHEMAS).map((name) => ({ params: { name } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify(SCHEMAS[params.name!], null, 2), { headers: { "Content-Type": "application/schema+json", "Access-Control-Allow-Origin": "*" } });
