// Labels and small rules for the community pages (issues, the board, the status line), shared by the server pages
// and the islands. What may be done is decided by the API; this only words it.
import type { IssueKind, IssueStatus } from "./api";

export const KIND_LABEL: Record<IssueKind, string> = {
  broken: "Broken",
  outdated: "Outdated",
  wrong_info: "Wrong information",
  feature: "Feature request",
  question: "Question",
};

/** What to write for each kind, in the form. */
export const KIND_HELP: Record<IssueKind, string> = {
  broken: "It fails, crashes or returns nothing on a value it should handle.",
  outdated: "Upstream has released a newer version than the registry has.",
  wrong_info: "The page says something untrue: inputs, outputs, keys, or what a run contacts.",
  feature: "Something the package should do.",
  question: "How to use it, or what a result means.",
};

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  confirmed: "Confirmed",
  fixed: "Fixed",
  wont_fix: "Won't fix",
  duplicate: "Duplicate",
};

/** A status badge's tone, from global.css. */
export const STATUS_TONE: Record<IssueStatus, string> = { open: "info", confirmed: "warn", fixed: "ok", wont_fix: "plain", duplicate: "plain" };

export const STATE_TONE: Record<string, string> = { working: "ok", mixed: "warn", failing: "bad", unknown: "none" };

/** Where an issue lives on the site. */
export const issueHref = (ref: string, number: number) => `/${ref}/issues/${number}`;

/**
 * The platform a browser is on, as ot reports it (os/arch), to prefill forms; "" when unknown. Macs report Intel in
 * the user agent whatever their chip, so for them only the system is given.
 */
export function guessPlatform(ua: string): string {
  if (/Android|iPhone|iPad/i.test(ua)) return "";
  if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
  const os = /Windows/i.test(ua) ? "windows" : /Linux|X11/i.test(ua) ? "linux" : "";
  if (!os) return "";
  return `${os}/${/arm64|aarch64/i.test(ua) ? "arm64" : "amd64"}`;
}
