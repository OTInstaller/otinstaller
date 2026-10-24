// The choices on a tool's "Report a problem" page (/{ns}/{name}/report) and the small rules around them, shared by
// the page, its island and the links that open it. Where each one goes is decided by the API: an issue, a count
// without a sign-in (POST /problem-reports), or a private report to the reviewers.
import type { IssueKind } from "./api";

export type ReportChoiceKey = "broken" | "error" | "outdated" | "wrong_info" | "abuse";

export interface ReportChoice {
  key: ReportChoiceKey;
  label: string;
  help: string;
  /** The public issue it becomes when signed in; null for a private report. */
  issue: IssueKind | null;
  /** What it counts as without a sign-in; null when it needs words (or goes to the reviewers). */
  counts: "broken" | "outdated" | null;
}

export const REPORT_CHOICES: ReportChoice[] = [
  { key: "broken", label: "It doesn't work", help: "It fails, crashes, hangs, or finds nothing on a value it should handle.", issue: "broken", counts: "broken" },
  { key: "error", label: "It shows an error", help: "It stops with an error message. You can paste the message, minus anything personal.", issue: "broken", counts: "broken" },
  { key: "outdated", label: "It's out of date", help: "Its project has released a newer version than the registry has.", issue: "outdated", counts: "outdated" },
  { key: "wrong_info", label: "Something on this page is wrong", help: "Its inputs, outputs, keys, or what a run contacts.", issue: "wrong_info", counts: null },
  { key: "abuse", label: "Malware, abuse or a legal problem", help: "Goes privately to the registry's reviewers, not to the public.", issue: null, counts: null },
];

/** The choice a ?kind= names, or null. Only the choices' own keys match, never "toString" and the like. */
export function reportChoice(param: string | null | undefined): ReportChoice | null {
  return REPORT_CHOICES.find((c) => c.key === param) ?? null;
}

/** The report page, with a choice and a version picked when given: /ns/name/report?kind=broken&v=1.2.0. */
export function reportHref(ref: string, opts: { kind?: ReportChoiceKey; version?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.kind) q.set("kind", opts.kind);
  if (opts.version) q.set("v", opts.version);
  const query = q.toString();
  return `/${ref}/report${query ? `?${query}` : ""}`;
}

/** The longest text an issue can have (MAX_BODY in api/src/community.ts). */
export const MAX_ISSUE_BODY = 8000;

/**
 * An issue's text with the error message someone pasted, as a code block under its own heading. The fence is longer
 * than any run of backticks in the message, so the message can't end the block early.
 */
export function withError(body: string, error: string): string {
  const message = error.replace(/^\n+|\s+$/g, "");
  if (!message.trim()) return body.trim();
  const fence = "`".repeat(Math.max(3, ...[...message.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${body.trim()}\n\n**Error**\n\n${fence}\n${message}\n${fence}`.trim();
}
