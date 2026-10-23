// The comparison table on input pages: every tool that takes one input type, side by side, with facts from the
// manifests (what it finds, keys, what it contacts, personal data, runtime) and the nightly health check. No ratings:
// nothing here is anyone's opinion. Rendered by components/CompareTable.astro.
import type { ToolSummary } from "./api";
import { entityLabel, healthLabel } from "./format";

export interface Footprint {
  label: string;
  tone: "ok" | "none" | "warn";
  /** For sorting: offline first, the ones that may notify the target last. */
  rank: number;
}

/** What a run of the tool reaches, from its ethics flags and network declaration. */
export function footprint(t: Pick<ToolSummary, "ethics" | "egress">): Footprint {
  if (t.egress === false) return { label: "Offline", tone: "ok", rank: 0 };
  if (!t.ethics) return { label: "Not stated", tone: "none", rank: 2 };
  if (t.ethics.notifies_target) return { label: "May notify the target", tone: "warn", rank: 4 };
  if (t.ethics.touches_target) return { label: "Contacts the target", tone: "warn", rank: 3 };
  return { label: "Online, passive", tone: "none", rank: 1 };
}

export interface CompareRow {
  ref: string;
  href: string;
  finds: string;
  key: string;
  footprint: Footprint;
  personal: string;
  runtime: string;
  health: { cls: string; text: string; rank: number };
  installs: number;
}

const HEALTH_RANK: Record<string, number> = { healthy: 0, unknown: 1, not_checked: 1, broken: 2 };

/** One row per tool, healthiest first, then most installed, then by name. */
export function compareRows(tools: ToolSummary[], now = Date.now()): CompareRow[] {
  return tools
    .filter((t) => t.kind !== "guide")
    .map((t) => {
      const ref = `${t.namespace}/${t.name}`;
      return {
        ref,
        href: `/${ref}`,
        finds: t.outputs.length ? t.outputs.slice(0, 4).map(entityLabel).join(", ") + (t.outputs.length > 4 ? "…" : "") : "—",
        key: t.needs_keys ? "Required" : "None",
        footprint: footprint(t),
        personal: t.ethics ? (t.ethics.collects_personal_data ? "Yes" : "No") : "—",
        runtime: t.runtime === "docker" ? "Docker" : t.runtime === "pipx" ? "Python" : "—",
        health: { ...healthLabel(t, now), rank: HEALTH_RANK[t.health] ?? 1 },
        installs: t.installs_30d,
      };
    })
    .sort((a, b) => a.health.rank - b.health.rank || b.installs - a.installs || a.ref.localeCompare(b.ref));
}
