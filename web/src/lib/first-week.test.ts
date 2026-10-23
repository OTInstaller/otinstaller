import { describe, expect, it } from "vitest";
import { firstWeekCounts, firstWeekPlatforms, firstWeekSaid, firstWeekTone } from "./first-week";

describe("first-week words", () => {
  it("says what people said, or that nobody has", () => {
    expect(firstWeekSaid({ works: 3, broken: 1 })).toBe("works for 3 people, broken for 1 person");
    expect(firstWeekSaid({ works: 0, broken: 2 })).toBe("broken for 2 people");
    expect(firstWeekSaid({ works: 0, broken: 0 })).toBe("nobody has said yet whether it works");
  });

  it("judges the counts as the status line does", () => {
    expect(firstWeekTone({ works: 0, broken: 0 })).toBe("none");
    expect(firstWeekTone({ works: 4, broken: 0 })).toBe("ok");
    expect(firstWeekTone({ works: 4, broken: 1 })).toBe("warn");
    expect(firstWeekTone({ works: 1, broken: 1 })).toBe("warn");
    expect(firstWeekTone({ works: 1, broken: 2 })).toBe("bad");
  });

  it("words the counts for a badge, and the platforms, most reports first", () => {
    expect(firstWeekCounts({ works: 2, broken: 1 })).toBe("2 works, 1 broken");
    expect(firstWeekCounts({ works: 0, broken: 0 })).toBe("no reports yet");
    expect(firstWeekPlatforms({ unknown: { works: 9, broken: 0 }, "darwin/arm64": { works: 1, broken: 0 }, "linux/amd64": { works: 2, broken: 1 } }))
      .toEqual(["linux/amd64 (2 works, 1 broken)", "darwin/arm64 (1 works)"]);
  });
});
