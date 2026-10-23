// Direct publishing: creating a registry namespace (`ot namespace create`) and uploading a release (`ot publish`).
// The rules are in direct.ts; validation and checks run in the publish queue (publish.ts).
import type { App } from "../env";
import { acceptUpload, createNamespace } from "../direct";
import { requireUser } from "./auth";

export function directRoutes(app: App) {
  app.post("/namespaces", async (c) => {
    const u = requireUser(c);
    const body = await c.req.json<{ name?: unknown; kind?: unknown }>().catch(() => ({}) as { name?: unknown; kind?: unknown });
    return c.json(await createNamespace(c.env, u, body), 201);
  });

  // ?namespace=&name=&version=, and the files as multipart/form-data. Answers 202 with the job to follow.
  app.post("/publish", async (c) => c.json(await acceptUpload(c), 202));
}
