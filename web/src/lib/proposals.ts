// Labels for change proposals to community packages, shared by the server pages and the islands. What may be done is
// decided by the API (api/src/proposals.ts); this only words it.
import type { ProposalFile, ProposalStatus, ToolDetail } from "./api";

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  open: "Waiting for a reviewer",
  changes_requested: "Changes requested",
  merged: "Merged and released",
  rejected: "Turned down",
  withdrawn: "Withdrawn",
};

export const PROPOSAL_STATUS_TONE: Record<ProposalStatus, string> = { open: "info", changes_requested: "warn", merged: "ok", rejected: "plain", withdrawn: "plain" };

/** The files a proposal can change, in the order they are shown. */
export const PROPOSAL_FILES: ProposalFile[] = ["otinstaller.yaml", "Dockerfile", "README.md"];

export const proposalHref = (ref: string, number: number) => `/${ref}/changes/${number}`;

/** A community wrapper: its homepage is the project it packages, not its own repository. Only wrappers take proposals. */
export const isWrapper = (t: Pick<ToolDetail, "community_packaged" | "homepage" | "repo_url">) => !!t.community_packaged && !!t.homepage && t.homepage !== t.repo_url;
