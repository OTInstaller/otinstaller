// Entry point of the image mirror Worker (wrangler.mirror.jsonc). The registry itself is in ./registry.ts.
import { mirrorFetch, type MirrorEnv } from "./registry";

export default {
  async fetch(req: Request, env: MirrorEnv): Promise<Response> {
    try {
      return await mirrorFetch(req, env);
    } catch (err) {
      console.error("mirror error", err);
      return Response.json({ errors: [{ code: "UNKNOWN", message: "internal error" }] }, { status: 500 });
    }
  },
} satisfies ExportedHandler<MirrorEnv>;
