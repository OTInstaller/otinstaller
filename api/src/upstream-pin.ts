// Which upstream release a community wrapper's Dockerfile builds, read from the Dockerfile itself (there is no manifest
// field for it): the template's ARG UPSTREAM_VERSION, `go install <module>@<version>`, `pip install pkg==<version>` or
// `git+<repo>@<ref>`, `git clone` plus `checkout` or `--branch`, `cargo install --tag` or `--version`, or a release
// download or raw file URL at a tag. Submissions (submissions.ts) need one to be conformant; the upstream watcher (upstream.ts) compares it
// with upstream's latest release, and bump pull requests change exactly that line.

export type PinKind = "arg" | "go" | "pip" | "pip_git" | "git" | "cargo" | "cargo_git" | "release_url" | "raw_url";

export interface Pin {
  kind: PinKind;
  /** The version or tag (with any leading v as written), or a commit SHA. */
  ref: string;
  /** For pip pins, the PyPI project; for cargo, the crate. */
  package?: string;
  /** 1-based line of the Dockerfile the pin is on (the first line of a continued RUN). */
  line: number;
}

const SHA = /^[0-9a-f]{40}$/;

/** Whether a pin names a commit rather than a release. */
export const isCommitPin = (p: Pin) => SHA.test(p.ref);

/** Dockerfile instructions with continuation lines joined, each with the line it starts on. */
function instructions(dockerfile: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur: { text: string; line: number } | null = null;
  dockerfile.split("\n").forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    if (!cur && /^\s*(#|$)/.test(l)) return;
    if (!cur) cur = { text: "", line: i + 1 };
    const cont = /\\\s*$/.test(l);
    cur.text += ` ${l.replace(/\\\s*$/, "")}`;
    if (!cont) {
      out.push({ text: cur.text.trim(), line: cur.line });
      cur = null;
    }
  });
  if (cur) out.push({ text: (cur as { text: string }).text.trim(), line: (cur as { line: number }).line });
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds the pin of the upstream repository (`github.com/owner/repo` or `gitlab.com/group/project`) in a Dockerfile,
 * or null. Pins of other projects the Dockerfile also builds (a helper like massdns) are ignored.
 */
export function findPin(dockerfile: string, upstream: string): Pin | null {
  const repo = upstream.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  const name = repo.split("/").pop()!;
  const repoRe = escape(repo);
  const steps = instructions(dockerfile);
  const pins: Pin[] = [];
  let pipSeen = false;
  for (const { text, line } of steps) {
    let m: RegExpExecArray | null;
    if ((m = /^ARG\s+UPSTREAM_VERSION=["']?([^\s"']+)/i.exec(text))) pins.push({ kind: "arg", ref: m[1]!, line });
    if (!/^RUN\s/i.test(text)) continue;
    // go install github.com/owner/repo[/v2][/cmd/x]@ref
    for (const g of text.matchAll(new RegExp(`go install [^&;|]*?\\b(${repoRe}(?:/[\\w.\\-/]*)?)@([\\w.\\-+]+)`, "gi"))) pins.push({ kind: "go", ref: g[2]!, line });
    // pip install git+https://github.com/owner/repo[.git]@ref
    for (const g of text.matchAll(new RegExp(`git\\+https?://${repoRe}(?:\\.git)?@([\\w.\\-+]+)`, "gi"))) pins.push({ kind: "pip_git", ref: g[1]!, line });
    // git clone [--branch ref] https://github.com/owner/repo[.git] ... && git [-C dir] checkout ref
    if (new RegExp(`git clone[^&;]*https?://${repoRe}(?:\\.git)?\\b`, "i").test(text)) {
      const branch = /git clone[^&;]*--branch[= ]([\w.\-+]+)/i.exec(text);
      const checkout = /git (?:-C \S+ )?checkout (?:--quiet |-q )?([\w.\-+]+)/i.exec(text);
      const ref = checkout?.[1] ?? branch?.[1];
      if (ref) pins.push({ kind: "git", ref, line });
    }
    // cargo install --git https://github.com/owner/repo --tag ref | cargo install crate --version ver
    if ((m = new RegExp(`cargo install[^&;]*--git https?://${repoRe}(?:\\.git)?\\b[^&;]*--tag[= ]([\\w.\\-+]+)`, "i").exec(text))) pins.push({ kind: "cargo_git", ref: m[1]!, line });
    for (const g of text.matchAll(/cargo install[^&;]*?\b([a-z0-9_-]+) --version[= ]([\w.\-+]+)/gi)) {
      if (norm(g[1]!) === norm(name)) pins.push({ kind: "cargo", ref: g[2]!, package: g[1]!, line });
    }
    // https://github.com/owner/repo/releases/download/<tag>/...
    for (const g of text.matchAll(new RegExp(`https?://${repoRe}/releases/download/([\\w.\\-+]+)/`, "gi"))) pins.push({ kind: "release_url", ref: g[1]!, line });
    // https://raw.githubusercontent.com/owner/repo/<ref>/file, or GitLab's /-/raw/<ref>/file
    const [owner, project] = [repo.split("/").slice(1, -1).join("/"), name];
    const raw = repo.startsWith("github.com/")
      ? new RegExp(`https://raw\\.githubusercontent\\.com/${escape(owner)}/${escape(project)}/([\\w.\\-+]+)/`, "gi")
      : new RegExp(`https://${repoRe}/-/raw/([\\w.\\-+]+)/`, "gi");
    for (const g of text.matchAll(raw)) pins.push({ kind: "raw_url", ref: g[1]!, line });
    // pip install "pkg==ver": the project named like the repository, else the first pinned project of the first pip line.
    if (/pip3? install/i.test(text)) {
      const reqs = [...text.matchAll(/["']?([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([\w.\-+!]+)["']?/g)].map((g) => ({ pkg: g[1]!, ref: g[2]! }));
      const own = reqs.find((r) => norm(r.pkg) === norm(name) || norm(r.pkg) === norm(name.replace(/^python-|-python$/g, "")));
      const pick = own ?? (pipSeen ? undefined : reqs[0]);
      if (reqs.length) pipSeen = true;
      if (pick) pins.push({ kind: "pip", ref: pick.ref, package: pick.pkg, line });
    }
  }
  // The template's ARG wins; then whichever pin names the upstream most directly.
  const order: PinKind[] = ["arg", "go", "pip_git", "cargo_git", "git", "cargo", "release_url", "raw_url", "pip"];
  pins.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.line - b.line);
  return pins[0] ?? null;
}
