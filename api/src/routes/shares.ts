// Shared results routes: uploading runs for a 24-hour link (anyone; signed-in sharers own theirs), reading one, deleting
// one, a person's own list, and the staff takedown. The rules are in ../shares.ts.
import type { App } from "../env";
import { apiError, rateLimited, windowRetry } from "../lib/errors";
import { overLimit } from "../trust";
import { audit, requireUser } from "./auth";
import { requireReviewer } from "./review";
import { createShare, deleteShare, listShares, MAX_SHARE_BYTES, readShare, removeShares } from "../shares";

export function shareRoutes(app: App) {
  // Anyone can share; a signed-in sharer owns the share (only they see that). 20 an hour per address, 60 per account.
  app.post("/shares", async (c) => {
    const tooLarge = () => apiError(413, "share_too_large", `the upload is over ${MAX_SHARE_BYTES / 1_048_576} MB`, "share fewer runs at once");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_SHARE_BYTES) tooLarge();
    const user = c.get("user");
    const limited = user
      ? await overLimit(c.env, "share-user", user.id, 60, 3_600_000)
      : await overLimit(c.env, "share-ip", c.req.header("cf-connecting-ip") ?? "unknown", 20, 3_600_000);
    if (limited) rateLimited("too_many_requests", `at most ${user ? 60 : 20} shares an hour`, "wait and try again, or share several runs in one link", windowRetry(3_600_000), user ? 60 : 20, 3600);
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_SHARE_BYTES) tooLarge();
    const share = await createShare(c.env, user, new TextDecoder().decode(body));
    c.header("Cache-Control", "private, no-store");
    return c.json(share, 201);
  });

  // Never cached: a deleted or expired share must stop answering at once.
  app.get("/shares/:id", async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex");
    return c.json(await readShare(c.env, c.req.param("id")));
  });

  // The owner, or anyone with {delete_token}.
  app.delete("/shares/:id", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    await deleteShare(c.env, c.get("user"), c.req.param("id"), b.delete_token);
    return c.body(null, 204);
  });

  app.get("/me/shares", async (c) => {
    const user = requireUser(c);
    c.header("Cache-Control", "private, no-store");
    return c.json({ shares: await listShares(c.env, user) });
  });

  // Staff take down a share someone reported.
  app.delete("/admin/shares/:id", async (c) => {
    const reviewer = requireReviewer(c);
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(`SELECT id FROM shares WHERE id = ?`).bind(id).first<{ id: string }>();
    if (!row) apiError(404, "share_not_found", "no such shared result");
    await removeShares(c.env, [row.id]);
    await audit(c.env.DB, reviewer.id, "user", "share.remove", "share", row.id).run();
    return c.body(null, 204);
  });
}
