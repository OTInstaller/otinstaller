import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTALLS, NO_DOCKER } from "./install";

// The install block (lib/install.ts) and the getting-started doc (Markdown, which cannot import the component)
// must say the same thing. The same goes for the no-Docker edition's install command.
describe("install commands", () => {
  it("appear verbatim in docs/getting-started.md", () => {
    const doc = readFileSync(fileURLToPath(new URL("../pages/docs/getting-started.md", import.meta.url)), "utf8");
    for (const i of INSTALLS) expect(doc).toContain(i.command);
    expect(doc).toContain(NO_DOCKER.command);
  });
});
