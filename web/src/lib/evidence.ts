// What the tool page says about a release, as sentences with dates and links: pinned, signed, scanned, works,
// backed up, reviewed. Built from the tool, its latest scans and the manifest endpoint (which carries the
// registry's fallback copies). Unmet lines are kept, in neutral, with the reason.
import type { ManifestResponse, Scans, ToolDetail } from "./api";
import { ago, formatDate } from "./format";

export interface EvidenceLine {
  key: "pinned" | "signed" | "scanned" | "works" | "backup" | "reviewed";
  label: string;
  /** Met, or shown in neutral with a reason. */
  met: boolean;
  /** Plain text and markup-free parts; `strong` parts are rendered in the text colour. */
  parts: (string | { strong: string } | { code: string } | { link: string; href: string })[];
  href?: string;
}

/** The latest result of each scan kind (the API lists every run, oldest first). */
export function latestScans(scans: Scans | null): Map<string, Scans["scans"][number]> {
  const m = new Map<string, Scans["scans"][number]>();
  for (const s of scans?.scans ?? []) m.set(s.kind, s);
  return m;
}

/** Scan rows grouped into runs (a run is every row that reports within five minutes of the first), newest first. */
export function scanRuns(scans: Scans | null): { ran_at: number; rows: Scans["scans"] }[] {
  const rows = [...(scans?.scans ?? [])].sort((a, b) => a.ran_at - b.ran_at);
  const runs: { ran_at: number; rows: Scans["scans"] }[] = [];
  for (const r of rows) {
    const cur = runs[runs.length - 1];
    if (cur && r.ran_at - cur.ran_at < 5 * 60 * 1000 && !cur.rows.some((x) => x.kind === r.kind)) cur.rows.push(r);
    else runs.push({ ran_at: r.ran_at, rows: [r] });
  }
  return runs.reverse();
}

export function shortDigest(d: string): string {
  const hex = d.replace(/^sha256:/, "");
  return hex.length > 16 ? `sha256:${hex.slice(0, 8)}…${hex.slice(-6)}` : d;
}

export function evidence(t: ToolDetail, scans: Scans | null, manifest: ManifestResponse | null): EvidenceLine[] {
  const ref = `${t.namespace}/${t.name}`;
  const m = t.manifest;
  const latest = latestScans(scans);
  const out: EvidenceLine[] = [];

  // Pinned.
  const image = m.runtime?.image;
  const wheel = m.runtime?.wheel_sha256;
  if (image && image.includes("@sha256:")) {
    out.push({ key: "pinned", label: "Pinned", met: true, href: `/${ref}/versions`, parts: ["image ", { code: shortDigest(image.split("@")[1]!) }, ". The same bytes on every install; ", { code: "ot" }, " pulls by digest, never by tag."] });
  } else if (wheel) {
    out.push({ key: "pinned", label: "Pinned", met: true, href: `/${ref}/versions`, parts: ["wheel ", { code: shortDigest(`sha256:${wheel}`) }, " from PyPI. ", { code: "ot" }, " re-hashes the file after download and refuses a mismatch."] });
  } else {
    out.push({ key: "pinned", label: "Pinned", met: false, parts: ["No digest or hash is recorded for this version."] });
  }

  // Signed.
  const sig = latest.get("signature");
  if (scans?.signed && scans.signer_identity) {
    out.push({
      key: "signed", label: "Signed", met: true, href: `/${ref}/security`,
      parts: ["by ", { strong: scans.signer_identity }, scans.signer_issuer ? ` via ${scans.signer_issuer.replace(/^https?:\/\//, "")}` : "", sig ? `, verified by the registry on ${formatDate(sig.ran_at)}` : "", ". ", { code: "ot" }, " checks the same identity before every install and refuses another signer."],
    });
  } else if (t.manifest_held_by_registry) {
    out.push({ key: "signed", label: "Not signed", met: false, href: `/${ref}/security`, parts: ["the manifest is held by the registry rather than in the repository, so no release workflow signs it. ", { code: "ot" }, " warns before installing."] });
  } else {
    out.push({ key: "signed", label: "Not signed", met: false, href: `/${ref}/security`, parts: ["this release carries no signature the registry could verify. ", { code: "ot" }, " warns before installing."] });
  }

  // Scanned.
  const vuln = latest.get("vuln");
  const mal = latest.get("malware");
  const sbom = latest.get("sbom");
  if (vuln || mal || sbom) {
    const when = Math.max(vuln?.ran_at ?? 0, mal?.ran_at ?? 0, sbom?.ran_at ?? 0);
    const v = vuln?.summary;
    const bits: EvidenceLine["parts"] = [{ strong: formatDate(when) }, ": "];
    if (v) bits.push(`${v.critical} critical, ${v.high} high, ${v.medium} medium, ${v.low} low vulnerabilities` + (v.fixable_critical + v.fixable_high > 0 ? ` (${v.fixable_critical + v.fixable_high} high or critical with a fix available)` : ""));
    if (mal) bits.push(`${v ? "; " : ""}${mal.summary?.secrets?.count ?? 0} embedded secrets, ${mal.summary?.malware?.count ?? 0} malware heuristics`);
    if (sbom) bits.push(`; SBOM with ${sbom.summary?.packages ?? "?"} packages`);
    bits.push(".");
    const failed = [vuln, mal].some((s) => s?.result === "fail");
    out.push({ key: "scanned", label: failed ? "Scan failed" : vuln?.result === "warn" ? "Scan warnings" : "Scanned", met: !failed, href: `/${ref}/security`, parts: bits });
  } else {
    out.push({ key: "scanned", label: "Not scanned", met: false, href: `/${ref}/security`, parts: ["No scan results are recorded for this version."] });
  }

  // Works.
  const smoke = latest.get("smoke");
  const checked = t.health_checked_at ? ` (${ago(t.health_checked_at)})` : "";
  const health = t.health === "healthy" ? `the nightly health check passed${checked}` : t.health === "broken" ? `three nightly health checks in a row failed${checked}, so it is marked possibly broken` : t.health === "not_checked" ? "no nightly health check: the manifest declares no test input" : "the nightly health check has not run yet";
  if (smoke && smoke.summary?.status !== "skipped") {
    const s = smoke.summary;
    out.push({ key: "works", label: t.health === "broken" ? "Possibly broken" : "Works", met: smoke.result === "pass" && t.health !== "broken", href: `/${ref}/security`, parts: [`smoke test ${smoke.result === "pass" ? "passed" : "failed"} on `, { strong: formatDate(smoke.ran_at) }, ` (exit ${s?.exit_code ?? "?"}${s?.duration_ms ? ` in ${(s.duration_ms / 1000).toFixed(1)} s` : ""}, offline sandbox); ${health}.`] });
  } else {
    out.push({ key: "works", label: t.health === "healthy" ? "Works" : "Not checked", met: t.health === "healthy", href: `/${ref}/security`, parts: [`no smoke test was run for this version; ${health}.`] });
  }

  // Backed up.
  if (manifest?.mirror_image) {
    out.push({ key: "backup", label: "Backed up", met: true, href: "/docs/security", parts: ["a copy of this image is on the registry's mirror. If the original registry refuses it, ", { code: "ot" }, " pulls the same digest from the mirror and checks the same signature."] });
  } else if (manifest?.wheel_url) {
    out.push({ key: "backup", label: "Backed up", met: true, href: "/docs/security", parts: ["a copy of this wheel is kept by the registry. If PyPI removes it, ", { code: "ot" }, " downloads the copy and checks the same hash."] });
  } else {
    out.push({ key: "backup", label: "No public copy", met: false, href: "/docs/security", parts: ["the registry keeps no public copy of this artifact yet (copies of non-OSI licences are private, and new releases are copied after their scan)."] });
  }

  // Reviewed.
  out.push(
    t.verified
      ? { key: "reviewed", label: "Reviewed", met: true, href: `/${t.namespace}`, parts: [{ strong: t.namespace }, " is a verified publisher: the registry confirmed who runs it, and a person reviewed its first release against the ", { link: "acceptable-use rules", href: "/policy/acceptable-use" }, "."] }
      : { key: "reviewed", label: "Reviewed", met: true, href: `/${t.namespace}`, parts: ["a person reviewed ", { strong: t.namespace }, "'s first release against the ", { link: "acceptable-use rules", href: "/policy/acceptable-use" }, " before anything from it was listed."] },
  );
  return out;
}

/** The example value for an input: the manifest's own example, else its test input, else a realistic value of the type. */
export function inputExample(m: { test?: { input: Record<string, unknown> } }, i: { name: string; type: string; example?: unknown }): string {
  if (i.example != null && i.example !== "") return String(i.example);
  const t = m.test?.input?.[i.name];
  if (t != null && t !== "") return String(t);
  return exampleValue(i.type, i.name);
}

/** The typed-input prefix for a type (d: for domain), or null. */
export function prefixFor(type: string): string | null {
  return ({ email: "e", username: "u", domain: "d", phone: "p", ip: "ip", url: "url" } as Record<string, string>)[type] ?? null;
}

/** What each ethics flag means for this tool, in one sentence. */
export function ethicsLines(e: { touches_target: boolean; auth_required: boolean; collects_personal_data: boolean; notifies_target?: boolean }, egress: boolean): { yes: boolean; text: string; why: string }[] {
  return [
    { yes: e.touches_target, text: e.touches_target ? "Contacts the target directly" : "Does not contact the target", why: e.touches_target ? "it sends requests to the target's own servers or accounts, which can be logged or noticed" : "it reads public sources or third parties only; the target sees nothing" },
    { yes: !!e.notifies_target, text: e.notifies_target ? "The target may notice a run" : "The target cannot tell it ran", why: e.notifies_target ? "a password-reset email, a login alert or similar can reach them" : "no alert, email or visible request reaches the target" },
    { yes: e.auth_required, text: e.auth_required ? "Logs in to accounts" : "Does not log in to accounts", why: e.auth_required ? "it uses credentials or session cookies on third-party sites, which those sites may notice" : "no credentials or sessions are used" },
    { yes: e.collects_personal_data, text: e.collects_personal_data ? "Returns personal data" : "Returns no personal data", why: e.collects_personal_data ? "results can include names, accounts or other details about a person: handle them under your legal basis" : "results are about infrastructure or content, not people" },
    { yes: egress, text: egress ? "Goes online" : "Runs offline", why: egress ? "it needs the network; ot asks before an unattended run" : "the container has no network at all" },
  ];
}

/** A realistic example value per input type, for run commands that copy and work. */
export function exampleValue(type: string, name: string): string {
  switch (type) {
    case "email": return "ada@example.com";
    case "username": return "jane_doe";
    case "phone": return "+14155550100";
    case "domain": return "example.com";
    case "ip": return "192.0.2.1";
    case "url": return "https://example.com/page";
    case "name": return '"Jane Doe"';
    case "image": return "https://example.com/photo.jpg";
    case "crypto_address": return "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    case "hash": return "d41d8cd98f00b204e9800998ecf8427e";
    case "company": return '"Example Ltd"';
    case "integer": return "10";
    case "boolean": return "true";
    default: return `<${name}>`;
  }
}

/** A sample result envelope shaped from the declared outputs, so the page shows what comes back. */
export function sampleEnvelope(ref: string, version: string, runtime: string, outputs: string[], input: Record<string, string>): string {
  const ex: Record<string, Record<string, unknown>> = {
    account: { type: "account", value: "github.com/jane_doe", attrs: { site: "github.com" } },
    email: { type: "email", value: "ada@example.com", confidence: "high" },
    username: { type: "username", value: "jane_doe" },
    phone: { type: "phone", value: "+14155550100", attrs: { country: "US" } },
    domain: { type: "domain", value: "example.com" },
    subdomain: { type: "subdomain", value: "mail.example.com" },
    ip: { type: "ip", value: "192.0.2.1" },
    url: { type: "url", value: "https://example.com/page" },
    person: { type: "person", value: "Jane Doe", source: "gitlab.com" },
    organization: { type: "organization", value: "Example Ltd" },
    location: { type: "location", value: "51.5074,-0.1278", attrs: { city: "London" } },
    breach: { type: "breach", value: "ExampleBreach2021", attrs: { records: 12000 } },
    certificate: { type: "certificate", value: "CN=example.com", attrs: { issuer: "R3" } },
    dns_record: { type: "dns_record", value: "example.com A 192.0.2.1" },
    image: { type: "image", value: "https://example.com/photo.jpg", attrs: { phash: "8f373714acfcf4d0" } },
    document: { type: "document", value: "report.pdf", attrs: { author: "Jane Doe" } },
    crypto_address: { type: "crypto_address", value: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", attrs: { chain: "btc" } },
    transaction: { type: "transaction", value: "4a5e1e4b…", attrs: { amount: "0.5 BTC" } },
    other: { type: "other", value: "…" },
  };
  const entities = outputs.slice(0, 3).map((o) => ex[o] ?? { type: o, value: "…" });
  const env = { envelope: 1, tool: `${ref}@${version}`, runtime, input, started_at: "2026-10-21T09:00:00Z", duration_ms: 4100, exit_code: 0, entities, warnings: [] };
  return JSON.stringify(env, null, 2);
}
