// Trusted publishing routes: a namespace's trusted publishers, which only its owners manage
// (/me/namespaces/:ns/trusted-publishers), and the exchange a CI run makes for its token (POST /auth/oidc/token).
// The rules are in ../trusted.ts.
import type { Context } from "hono";
import type { App, AppEnv } from "../env";
import { apiError } from "../lib/errors";
import { requireUser } from "./auth";
import { addPublisher, exchangeIdToken, listPublishers, removePublisher } from "../trusted";

/** The namespace in the path, for one of its owners. */
async function ownedNamespace(c: Context<AppEnv>) {
  const user = requireUser(c);
  const ns = await c.env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE name = ?`).bind(c.req.param("ns")).first<{ id: string; name: string; status: string }>();
  if (!ns) apiError(404, "namespace_not_found", `${c.req.param("ns")} is not a registry namespace`);
  const m = await c.env.DB.prepare(`SELECT role FROM namespace_members WHERE namespace_id = ? AND user_id = ?`).bind(ns.id, user.id).first<{ role: string }>();
  if (m?.role !== "owner") apiError(403, "forbidden", `only ${ns.name}'s owners can manage its trusted publishers`);
  return { user, ns };
}

export function trustedRoutes(app: App) {
  // {id_token, namespace, package?} from a CI run. Anonymous: the ID token is the credential.
  app.post("/auth/oidc/token", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    c.header("Cache-Control", "private, no-store");
    return c.json(await exchangeIdToken(c.env, body));
  });

  app.get("/me/namespaces/:ns/trusted-publishers", async (c) => {
    const { ns } = await ownedNamespace(c);
    c.header("Cache-Control", "private, no-store");
    return c.json({ namespace: ns.name, publishers: await listPublishers(c.env, ns.id) });
  });

  app.post("/me/namespaces/:ns/trusted-publishers", async (c) => {
    const { user, ns } = await ownedNamespace(c);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    return c.json(await addPublisher(c.env, user, ns, body), 201);
  });

  app.delete("/me/namespaces/:ns/trusted-publishers/:id", async (c) => {
    const { user, ns } = await ownedNamespace(c);
    await removePublisher(c.env, user, ns, c.req.param("id"));
    return c.body(null, 204);
  });
}
