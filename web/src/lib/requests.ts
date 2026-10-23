// Labels for tool requests, shared by the server pages and the islands, and the signed-in person's view of a request
// that the islands on its page share. What may be done is decided by the API; this only words it.
import { api, type DeclineCode, type RequestStatus, type RequestViewer } from "./api";

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  in_progress: "Being packaged",
  published: "Published",
  declined: "Declined",
};

/** A status badge's tone, from global.css. */
export const REQUEST_STATUS_TONE: Record<RequestStatus, string> = { open: "info", accepted: "warn", in_progress: "warn", published: "ok", declined: "plain" };

export const DECLINE_LABEL: Record<DeclineCode, string> = {
  license: "Its license doesn't allow redistribution",
  archived: "The repository is archived",
  not_osint: "Not an OSINT tool",
  not_cli: "Not a command-line tool ot can run",
  needs_login: "Needs a login or session first",
  acceptable_use: "Against the acceptable use policy",
  unmaintained: "Unmaintained",
  duplicate: "Duplicate of another request or package",
  withdrawn: "Withdrawn by the person who asked",
  other: "Other",
};

/** Codes a triager can choose when declining (withdrawn is the requester's own). */
export const TRIAGE_DECLINE_CODES = (Object.keys(DECLINE_LABEL) as DeclineCode[]).filter((c) => c !== "withdrawn");

export const requestHref = (number: number) => `/requests/${number}`;

/** Whether a request still takes votes. */
export const takesVotes = (status: RequestStatus) => status === "open" || status === "accepted" || status === "in_progress";

const viewers = new Map<number, Promise<RequestViewer | null>>();

/** What the signed-in person may do on a request, asked once per page for every island; null when signed out. */
export function requestViewer(number: number): Promise<RequestViewer | null> {
  let p = viewers.get(number);
  if (!p) viewers.set(number, (p = api<RequestViewer>(`/requests/${number}/viewer`).catch(() => null)));
  return p;
}
