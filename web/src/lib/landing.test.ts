import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORY_LANDING, GENERIC_INPUTS, INPUT_LANDING } from "./landing";

// Every input type and category the manifest schema allows gets a landing page, so each needs copy (or, for the
// generic value types, a noindex). The schema is the source of truth for both lists.
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/schema/v1.json", import.meta.url)), "utf8"));
const inputs: string[] = schema.$defs.inputType.enum;
const categories: string[] = schema.$defs.category.enum;

describe("landing copy", () => {
  it("covers every input type in the schema", () => {
    for (const t of inputs) if (!GENERIC_INPUTS.has(t)) expect(INPUT_LANDING[t], t).toBeDefined();
    for (const t of GENERIC_INPUTS) expect(inputs).toContain(t);
  });
  it("covers every category in the schema", () => {
    for (const c of categories) expect(CATEGORY_LANDING[c], c).toBeDefined();
  });
  it("keeps titles and descriptions within what search results show", () => {
    for (const [t, l] of Object.entries(INPUT_LANDING)) {
      expect(l.title.length, `${t} title`).toBeLessThanOrEqual(110);
      expect(l.description.length, `${t} description`).toBeLessThanOrEqual(220);
      expect(l.lead.length, `${t} lead`).toBeGreaterThan(80);
      for (const [q, a] of l.faq) {
        expect(q.endsWith("?"), q).toBe(true);
        expect(a.length).toBeGreaterThan(40);
      }
    }
    for (const [c, l] of Object.entries(CATEGORY_LANDING)) expect(l.description.length, `${c} description`).toBeLessThanOrEqual(220);
  });
});
