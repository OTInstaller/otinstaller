// Contributor profile routes: a person's public profile, and hiding your own. Logic lives in ../people.ts.
import type { App } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { profile, setProfileHidden } from "../people";

export function peopleRoutes(app: App) {
  app.get("/people/:handle", async (c) => {
    const p = await profile(c.env, c.req.param("handle"));
    cached(c, 300);
    return c.json(p);
  });

  // Hiding a profile also hides the avatar on the person's posts; their handle still shows on what they wrote.
  app.put("/me/community-profile", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<{ hidden?: unknown }>().catch(() => ({}) as { hidden?: unknown });
    if (typeof b.hidden !== "boolean") apiError(400, "invalid_body", "send {hidden: true} or {hidden: false}");
    await setProfileHidden(c.env, u, b.hidden);
    c.header("Cache-Control", "private, no-store");
    return c.json({ hidden: b.hidden });
  });
}
