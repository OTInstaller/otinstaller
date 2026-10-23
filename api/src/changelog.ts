// Release notes for a version: read from the host's release for the tag when a release is published (the release
// webhook in sync.ts keeps them current), else from the version's section of CHANGELOG.md at the tagged commit.
// Stored as Markdown in versions.changelog and rendered when served; the versions routes live in index.ts.
import type { Env } from "./env";
import { imagesToAlt, renderPage } from "./content";
import type { RepoHost } from "./hosts/repo";

export const MAX_NOTES = 20000;

/** Files searched for a version's section when the release has no notes, most common first. */
export const CHANGELOG_FILES = ["CHANGELOG.md", "CHANGES.md", "HISTORY.md"];

/**
 * Notes as text that is safe to print anywhere: no control characters (terminal escapes) or bidirectional
 * overrides, Unix line ends, trimmed and capped. Null when nothing is left.
 */
export function cleanNotes(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, MAX_NOTES)
    .trim();
  return clean || null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The part of a changelog about one version: everything under the first heading that names it (`## [1.2.0]`,
 * `## v1.2.0 - 2026-10-01`, `### 1.2.0 (date)`) up to the next heading of the same or a higher level.
 */
export function changelogSection(md: string, version: string): string | null {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const names = new RegExp(`(^|[\\s\\[(])v?${escapeRe(version)}(?=$|[\\s\\]),:])`, "i");
  let level = 0;
  const out: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,4})\s+(.*)$/.exec(line);
    if (level === 0) {
      if (h && names.test(h[2]!)) level = h[1]!.length;
      continue;
    }
    if (h && h[1]!.length <= level) break;
    out.push(line);
  }
  return level ? cleanNotes(out.join("\n")) : null;
}

/** Where a repository file is shown at a commit, for relative links in notes. */
function blobBase(repoUrl: string | null, sha: string | null): string | null {
  if (!repoUrl || !sha) return null;
  return repoUrl.startsWith("https://gitlab.com/") ? `${repoUrl}/-/blob/${sha}/` : `${repoUrl}/blob/${sha}/`;
}

/**
 * Notes as sanitized HTML: raw HTML is escaped, relative links point at the repository at the tagged commit, and
 * images become their alt text (the registry does not copy images from notes).
 */
export function renderNotes(md: string, repoUrl: string | null, sha: string | null): string {
  const base = blobBase(repoUrl, sha);
  const at = (p: string) => (base ? base + p : "#");
  const r = renderPage(md, { file: "CHANGELOG.md", root: "", pages: new Set(), pageUrl: at, fileUrl: at, strict: false, allowHtml: false });
  return imagesToAlt(r.html);
}

/** The notes for a version's tag: the host's release, else its section of a changelog file. Never throws. */
export async function readNotes(host: RepoHost, tag: string, sha: string, version: string): Promise<{ notes: string; source: "release" | "file" } | null> {
  const release = cleanNotes(await host.releaseNotes(tag).catch(() => null));
  if (release) return { notes: release, source: "release" };
  for (const file of CHANGELOG_FILES) {
    const text = await host.fileAt(file, sha).catch(() => null);
    if (text === null) continue;
    const section = changelogSection(text, version);
    return section ? { notes: section, source: "file" } : null;
  }
  return null;
}

/**
 * Records a newly validated version's notes, unless a release webhook already did. Publishing never fails because
 * of notes: any host error just leaves them empty.
 */
export async function captureNotes(env: Env, host: RepoHost, versionId: string, tag: string, sha: string, version: string): Promise<void> {
  const found = await readNotes(host, tag, sha, version).catch(() => null);
  if (!found) return;
  await env.DB.prepare(`UPDATE versions SET changelog = ?, changelog_source = ? WHERE id = ? AND (changelog IS NULL OR changelog = '')`)
    .bind(found.notes, found.source, versionId).run();
}
