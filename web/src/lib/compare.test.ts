import { describe, expect, it } from "vitest";
import { compareRows, footprint } from "./compare";
import type { ToolSummary } from "./api";

const tool = (name: string, over: Partial<ToolSummary> = {}): ToolSummary => ({
  namespace: "ns", name, kind: "tool", summary: "", latest_version: "1.0.0", categories: [], inputs: ["email"], outputs: ["account"], runtime: "docker",
  stars: 0, installs_30d: 0, health: "unknown", verified: false, signed: true, needs_keys: false, manifest_held_by_registry: false,
  community_packaged: false, source_unavailable: false, status: "published", ...over,
});
const ethics = (over: Partial<NonNullable<ToolSummary["ethics"]>> = {}) => ({ touches_target: false, auth_required: false, collects_personal_data: false, ...over });

describe("footprint", () => {
  it("says what a run reaches, most careful first", () => {
    expect(footprint({ egress: false, ethics: ethics({ touches_target: true }) }).label).toBe("Offline");
    expect(footprint({ egress: true, ethics: ethics() }).label).toBe("Online, passive");
    expect(footprint({ egress: true, ethics: ethics({ touches_target: true }) }).label).toBe("Contacts the target");
    expect(footprint({ egress: true, ethics: ethics({ touches_target: true, notifies_target: true }) }).label).toBe("May notify the target");
  });
  it("copes with older API answers that have no ethics", () => {
    expect(footprint({}).label).toBe("Not stated");
  });
});

describe("compareRows", () => {
  const now = Date.UTC(2026, 9, 23);
  const rows = compareRows([
    tool("broken", { health: "broken", installs_30d: 500 }),
    tool("quiet", { health: "healthy", health_checked_at: now - 3_600_000, installs_30d: 3 }),
    tool("popular", { health: "healthy", installs_30d: 90, needs_keys: true, outputs: ["account", "email", "username", "url", "phone"], ethics: ethics({ collects_personal_data: true }) }),
    tool("guide", { kind: "guide" }),
  ], now);

  it("puts working tools first, then the most installed, and leaves guides out", () => {
    expect(rows.map((r) => r.ref)).toEqual(["ns/popular", "ns/quiet", "ns/broken"]);
  });
  it("fills each column from the summary", () => {
    expect(rows[0]).toMatchObject({ key: "Required", personal: "Yes", runtime: "Docker", finds: "account, email, username, url…", installs: 90 });
    expect(rows[1]!.health.text).toBe("Worked today");
    expect(rows[2]!.personal).toBe("—");
  });
});
