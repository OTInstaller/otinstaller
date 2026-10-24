// People's profile routes: a person's public profile, editing your own (what you wrote, your handle, hiding it), and
// moderators clearing a profile. Logic lives in ../people.ts.
import type { App } from "../env";
import { apiError } from "../lib/errors";
import { cached } from "../catalog";
import { requireUser } from "./auth";
import { requireReviewer } from "./review";
import { changeHandle, clearProfile, ownProfile, profile, setProfileHidden, updateProfile } from "../people";

export function peopleRoutes(app: App) {
  app.get("/people/:handle", async (c) => {
    const p = await profile(c.env, c.req.param("handle"));
    cached(c, 300);
    return c.json(p);
  });

  app.get("/me/profile", async (c) => {
    const u = requireUser(c);
    c.header("Cache-Control", "private, no-store");
    return c.json(await ownProfile(c.env, u));
  });

  // Display name, bio, location, website, links and hidden; what is left out stays as it was.
  app.put("/me/profile", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const p = await updateProfile(c.env, u, b);
    c.header("Cache-Control", "private, no-store");
    return c.json(p);
  });

  // A new handle, at most once every 30 days; the old one redirects to it.
  app.put("/me/handle", async (c) => {
    const u = requireUser(c);
    const b = await c.req.json<{ handle?: unknown }>().catch(() => ({}) as { handle?: unknown });
    const r = await changeHandle(c.env, u, b.handle);
    c.header("Cache-Control", "private, no-store");
    return c.json(r);
  });

  app.post("/admin/people/:handle/clear-profile", async (c) => {
    const staff = requireReviewer(c);
    await clearProfile(c.env, staff, c.req.param("handle"));
    return c.json({ cleared: true });
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
