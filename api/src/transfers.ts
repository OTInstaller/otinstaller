// Claims and transfers. A claim is the upstream owner of a community wrapper taking it over: they prove
// ownership (admin or Maintainer on the upstream repository through a linked account, or a one-time token in
// a .otinstaller-claim file there), then an admin completes it. A transfer is an owner offering a package to
// another namespace, whose owners accept it. Completing either moves the package with its versions, stars and
// installs, and its old address becomes a permanent alias.
import { deps, type Env } from "./env";
import { randomToken, sha256Hex, ulid } from "./lib/crypto";
import * as github from "./hosts/github";
import * as gitlab from "./hosts/gitlab";
import { githubUserToken, gitlabToken } from "./hosts/repo";
import { parseRepoRef } from "./imports";
import { audit } from "./routes/auth";
import { ownerEmails, sendEmail, staffEmails, templates } from "./notify";
import type { ToolRef } from "./trust";

export const CLAIM_FILE = ".otinstaller-claim";

export type Transfer = {
  id: string;
  tool_id: string;
  from_namespace_id: string;
  to_namespace_id: string;
  requested_by: string;
  kind: "claim" | "transfer";
  verification: string | null;
  claim_token_hash: string | null;
  source_choice: string | null;
  status: "pending" | "verified" | "accepted" | "completed" | "declined";
  upstream_url: string | null;
  verification_error: string | null;
  created_at: number;
  completed_at: number | null;
};

export class TransferError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string, public hint?: string) {
    super(message);
  }
}

const fail = (status: TransferError["status"], code: string, message: string, hint?: string): never => {
  throw new TransferError(status, code, message, hint);
};

export async function transferById(env: Env, id: string): Promise<Transfer | null> {
  return env.DB.prepare(`SELECT * FROM transfers WHERE id = ?`).bind(id).first<Transfer>();
}

/** How a transfer looks to the people involved. */
export async function transferView(env: Env, t: Transfer) {
  const names = await env.DB.prepare(
    `SELECT (SELECT n.name || '/' || tl.name FROM tools tl JOIN namespaces n ON n.id = tl.namespace_id WHERE tl.id = ?) AS ref,
       (SELECT name FROM namespaces WHERE id = ?) AS from_ns, (SELECT name FROM namespaces WHERE id = ?) AS to_ns,
       (SELECT login FROM users WHERE id = ?) AS requested_by`,
  ).bind(t.tool_id, t.from_namespace_id, t.to_namespace_id, t.requested_by).first<{ ref: string; from_ns: string; to_ns: string; requested_by: string }>();
  return {
    id: t.id, kind: t.kind, status: t.status, ref: names?.ref, from: names?.from_ns, to: names?.to_ns, requested_by: names?.requested_by,
    upstream_url: t.upstream_url ?? undefined, verification: t.verification ?? undefined, verification_error: t.verification_error ?? undefined,
    claim_file: t.kind === "claim" ? CLAIM_FILE : undefined, created_at: t.created_at, completed_at: t.completed_at ?? undefined,
  };
}

async function isOwner(env: Env, namespaceId: string, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM namespace_members WHERE namespace_id = ? AND user_id = ? AND role = 'owner'`).bind(namespaceId, userId).first());
}

async function ownedNamespace(env: Env, userId: string, name?: string): Promise<{ id: string; name: string; status: string }> {
  const rows = (await env.DB.prepare(
    `SELECT n.id, n.name, n.status FROM namespace_members m JOIN namespaces n ON n.id = m.namespace_id WHERE m.user_id = ? AND m.role = 'owner'`,
  ).bind(userId).all<{ id: string; name: string; status: string }>()).results;
  const ns = name ? rows.find((r) => r.name === name) : rows.length === 1 ? rows[0] : undefined;
  if (!ns) {
    fail(400, "destination_required", name ? `you are not an owner of ${name}` : "say which of your namespaces should receive the package",
      rows.length ? `one of: ${rows.map((r) => r.name).join(", ")}` : "install the OTInstaller GitHub App on your account, or connect GitLab, to get a namespace first");
  }
  if (ns!.status === "rejected" || ns!.status === "suspended") fail(409, "namespace_not_allowed", `${ns!.name} is ${ns!.status}`);
  return ns!;
}

/** The upstream owner starts a claim on a community wrapper. The claim-file token is returned once. */
export async function startClaim(env: Env, userId: string, t: ToolRef, to?: string) {
  if (!t.community_packaged) fail(409, "not_community_packaged", `${t.namespace}/${t.name} is not a community wrapper; ask its owners for a transfer instead`);
  const dest = await ownedNamespace(env, userId, to);
  if (dest.id === t.namespace_id) fail(409, "same_namespace", "the package is already in that namespace");
  const latest = t.latest_version_id
    ? await env.DB.prepare(`SELECT json_extract(manifest_json, '$.homepage') AS homepage FROM versions WHERE id = ?`).bind(t.latest_version_id).first<{ homepage: string | null }>()
    : null;
  const upstream = latest?.homepage ?? null;
  if (!upstream || !parseRepoRef(upstream)) fail(409, "upstream_unknown", "this wrapper does not name its upstream repository", "write to support@otinstaller.com");
  const existing = await env.DB.prepare(`SELECT id FROM transfers WHERE tool_id = ? AND requested_by = ? AND kind = 'claim' AND status IN ('pending', 'verified')`)
    .bind(t.id, userId).first<{ id: string }>();
  const token = `otclaim_${randomToken(24)}`;
  const now = Date.now();
  const id = existing?.id ?? ulid(now);
  await env.DB.batch([
    existing
      ? env.DB.prepare(`UPDATE transfers SET to_namespace_id = ?, claim_token_hash = ?, status = 'pending', verification_error = NULL, updated_at = ? WHERE id = ?`)
        .bind(dest.id, await sha256Hex(token), now, id)
      : env.DB.prepare(
        `INSERT INTO transfers (id, tool_id, from_namespace_id, to_namespace_id, requested_by, kind, claim_token_hash, source_choice, status, upstream_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'claim', ?, 'upstream', 'pending', ?, ?, ?)`,
      ).bind(id, t.id, t.namespace_id, dest.id, userId, await sha256Hex(token), upstream, now, now),
    audit(env.DB, userId, "user", "transfer.claim", "tool", t.id, { transfer: id, to: dest.name }),
  ]);
  return { id, token, upstream: upstream! };
}

/**
 * Re-runs verification: admin (GitHub) or Maintainer and above (GitLab) on the upstream repository through
 * the claimer's linked account, or the claim token in .otinstaller-claim on its default branch.
 */
export async function verifyClaim(env: Env, tr: Transfer): Promise<Transfer> {
  if (tr.kind !== "claim") fail(409, "not_a_claim", "only claims are verified");
  if (tr.status !== "pending" && tr.status !== "verified") fail(409, "invalid_state", `this claim is ${tr.status}`);
  const ref = parseRepoRef(tr.upstream_url ?? "")!;
  let method: "linked_account" | "claim_file" | null = null;
  let error = "";
  try {
    if (ref.provider === "github") {
      const repo = await github.getRepo(deps.fetch, await githubUserToken(env, tr.requested_by), ref.path);
      if (repo?.permissions?.admin) method = "linked_account";
      else error = `your GitHub account is not an admin of ${ref.path}`;
    } else {
      const p = await gitlab.getProject(deps.fetch, await gitlabToken(env, tr.requested_by), ref.path);
      if (p && gitlab.accessLevel(p) >= 40) method = "linked_account";
      else error = `your GitLab account is not a Maintainer or Owner of ${ref.path}`;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  if (!method && tr.claim_token_hash) {
    const raw = ref.provider === "github"
      ? `https://raw.githubusercontent.com/${ref.path}/HEAD/${CLAIM_FILE}`
      : `https://gitlab.com/${ref.path}/-/raw/HEAD/${CLAIM_FILE}`;
    const res = await deps.fetch(raw, { headers: { "User-Agent": "otinstaller-registry" } });
    if (res.ok && (await sha256Hex((await res.text()).trim())) === tr.claim_token_hash) method = "claim_file";
    else error += `${error ? "; " : ""}${CLAIM_FILE} with your claim token was not found on the default branch of ${ref.path}`;
  }
  const now = Date.now();
  if (!method) {
    await env.DB.prepare(`UPDATE transfers SET verification_error = ?, updated_at = ? WHERE id = ?`).bind(error.slice(0, 500), now, tr.id).run();
    return { ...tr, verification_error: error };
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE transfers SET status = 'verified', verification = ?, verification_error = NULL, updated_at = ? WHERE id = ?`).bind(method, now, tr.id),
    audit(env.DB, tr.requested_by, "user", "transfer.verified", "transfer", tr.id, { method }),
  ]);
  if (tr.status !== "verified") {
    const v = await transferView(env, { ...tr, status: "verified" });
    await sendEmail(env, { to: await staffEmails(env, "admins"), kind: "claim", key: `claim-verified:${tr.id}`, ...templates.claimToReview(env, v.ref ?? "", v.to ?? "", tr.id) });
  }
  return { ...tr, status: "verified", verification: method, verification_error: null };
}

/** An owner offers a package to another namespace. */
export async function offerTransfer(env: Env, userId: string, isAdmin: boolean, t: ToolRef, toName: string) {
  if (!isAdmin && !(await isOwner(env, t.namespace_id, userId))) fail(403, "forbidden", "only the package's owners can transfer it");
  const dest = await env.DB.prepare(`SELECT id, name, status FROM namespaces WHERE name = ?`).bind(toName).first<{ id: string; name: string; status: string }>();
  if (!dest) fail(404, "namespace_not_found", `${toName} is not a namespace`);
  if (dest!.id === t.namespace_id) fail(409, "same_namespace", "the package is already in that namespace");
  if (dest!.status === "rejected" || dest!.status === "suspended") fail(409, "namespace_not_allowed", `${toName} is ${dest!.status}`);
  const now = Date.now();
  const id = ulid(now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO transfers (id, tool_id, from_namespace_id, to_namespace_id, requested_by, kind, source_choice, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'transfer', 'wrapper', 'pending', ?, ?)`,
    ).bind(id, t.id, t.namespace_id, dest!.id, userId, now, now),
    audit(env.DB, userId, "user", "transfer.offer", "tool", t.id, { transfer: id, to: toName }),
  ]);
  await sendEmail(env, {
    to: await ownerEmails(env, dest!.id), kind: "transfer", key: `transfer-offer:${id}`,
    ...templates.transferOffered(env, `${t.namespace}/${t.name}`, t.namespace, toName, id),
  });
  return id;
}

/** The receiving namespace's owner accepts a transfer, which completes it. */
export async function acceptTransfer(env: Env, userId: string, tr: Transfer) {
  if (tr.kind !== "transfer") fail(409, "not_a_transfer", "claims are completed by an admin after verification");
  if (tr.status !== "pending") fail(409, "invalid_state", `this transfer is ${tr.status}`);
  if (!(await isOwner(env, tr.to_namespace_id, userId))) fail(403, "forbidden", "only owners of the receiving namespace can accept");
  await env.DB.prepare(`UPDATE transfers SET status = 'accepted', accepted_by = ?, updated_at = ? WHERE id = ?`).bind(userId, Date.now(), tr.id).run();
  return completeTransfer(env, userId, { ...tr, status: "accepted" });
}

/** Either side declines (or the claimer withdraws). */
export async function declineTransfer(env: Env, userId: string, isAdmin: boolean, tr: Transfer) {
  if (!["pending", "verified", "accepted"].includes(tr.status)) fail(409, "invalid_state", `this transfer is ${tr.status}`);
  const allowed = isAdmin || tr.requested_by === userId || (await isOwner(env, tr.to_namespace_id, userId)) || (await isOwner(env, tr.from_namespace_id, userId));
  if (!allowed) fail(403, "forbidden", "only the people involved can decline");
  await env.DB.batch([
    env.DB.prepare(`UPDATE transfers SET status = 'declined', updated_at = ? WHERE id = ?`).bind(Date.now(), tr.id),
    audit(env.DB, userId, "user", "transfer.decline", "transfer", tr.id),
  ]);
}

/**
 * Moves the package in one batch: its namespace, an alias for the old address, the community label (gone for
 * claims), its source repository (paused for claims, whose future versions come from upstream), and closes
 * competing claims.
 */
export async function completeTransfer(env: Env, actorId: string, tr: Transfer) {
  if (tr.kind === "claim" && tr.status !== "verified") fail(409, "not_verified", "the claim is not verified yet");
  if (tr.kind === "transfer" && tr.status !== "accepted") fail(409, "not_accepted", "the receiving namespace has not accepted yet");
  const db = env.DB;
  const tool = await db.prepare(`SELECT t.id, t.name, n.name AS ns FROM tools t JOIN namespaces n ON n.id = t.namespace_id WHERE t.id = ?`)
    .bind(tr.tool_id).first<{ id: string; name: string; ns: string }>();
  const dest = await db.prepare(`SELECT name FROM namespaces WHERE id = ?`).bind(tr.to_namespace_id).first<{ name: string }>();
  if (!tool || !dest) fail(404, "not_found", "the package or namespace no longer exists");
  const clash = await db.prepare(`SELECT 1 FROM tools WHERE namespace_id = ? AND name = ?`).bind(tr.to_namespace_id, tool!.name).first();
  if (clash) fail(409, "name_taken", `${dest!.name} already has a package called ${tool!.name}`, "rename one of them first");
  const now = Date.now();
  const claim = tr.kind === "claim";
  await db.batch([
    db.prepare(`UPDATE tools SET namespace_id = ?, community_packaged = CASE WHEN ? THEN 0 ELSE community_packaged END, updated_at = ? WHERE id = ?`)
      .bind(tr.to_namespace_id, claim ? 1 : 0, now, tool!.id),
    db.prepare(`INSERT OR REPLACE INTO aliases (old_namespace, old_name, tool_id, created_at) VALUES (?, ?, ?, ?)`).bind(tool!.ns, tool!.name, tool!.id, now),
    db.prepare(`UPDATE sources SET namespace_id = ?, sync_status = CASE WHEN ? THEN 'paused' ELSE sync_status END WHERE tool_id = ?`)
      .bind(tr.to_namespace_id, claim ? 1 : 0, tool!.id),
    db.prepare(`UPDATE transfers SET status = 'completed', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?`).bind(now, actorId, now, tr.id),
    db.prepare(`UPDATE transfers SET status = 'declined', verification_error = 'another transfer of this package completed', updated_at = ?
                WHERE tool_id = ? AND id != ? AND status IN ('pending', 'verified', 'accepted')`).bind(now, tool!.id, tr.id),
    audit(db, actorId, "user", "transfer.complete", "tool", tool!.id, { transfer: tr.id, from: `${tool!.ns}/${tool!.name}`, to: `${dest!.name}/${tool!.name}`, kind: tr.kind }),
  ]);
  const oldRef = `${tool!.ns}/${tool!.name}`;
  const newRef = `${dest!.name}/${tool!.name}`;
  const to = [...(await ownerEmails(env, tr.from_namespace_id)), ...(await ownerEmails(env, tr.to_namespace_id))];
  await sendEmail(env, { to, kind: "transfer", key: `transfer-done:${tr.id}`, ...templates.transferCompleted(env, oldRef, newRef) });
  return { ref: newRef, alias: oldRef };
}
