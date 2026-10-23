// Labels for community submissions, shared by the server pages and the islands. What may be done is decided by the
// API; this only words it. The wizard's Dockerfile templates are in dockerfile-templates.ts.
import type { SubmissionStatus } from "./api";

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  submitted: "Waiting for a reviewer to start",
  releasing: "Building",
  in_review: "In review",
  changes_requested: "Changes requested",
  published: "Published",
  rejected: "Turned down",
  withdrawn: "Withdrawn",
  failed: "Failed",
};

export const SUBMISSION_STATUS_TONE: Record<SubmissionStatus, string> = {
  submitted: "info", releasing: "info", in_review: "warn", changes_requested: "warn", published: "ok", rejected: "plain", withdrawn: "plain", failed: "bad",
};

export const submissionHref = (number: number) => `/submissions/${number}`;
