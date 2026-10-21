import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "./redirects";

const to = (url: string) => canonicalRedirect(new URL(url), "otinstaller.com")?.headers.get("Location") ?? null;

describe("canonicalRedirect", () => {
  it("leaves canonical addresses alone", () => {
    expect(to("https://otinstaller.com/")).toBeNull();
    expect(to("https://otinstaller.com/input/email?value=x")).toBeNull();
    expect(to("http://localhost:4322/docs")).toBeNull();
  });
  it("sends www. and http to the apex over https, keeping the path and query", () => {
    expect(to("https://www.otinstaller.com/osintverse-community/sherlock")).toBe("https://otinstaller.com/osintverse-community/sherlock");
    expect(to("http://otinstaller.com/search?q=a")).toBe("https://otinstaller.com/search?q=a");
    expect(to("http://www.otinstaller.com/")).toBe("https://otinstaller.com/");
  });
  it("strips trailing slashes everywhere but the root", () => {
    expect(to("https://otinstaller.com/docs/")).toBe("https://otinstaller.com/docs");
    expect(to("http://localhost:4322/input/email//")).toBe("http://localhost:4322/input/email");
    expect(canonicalRedirect(new URL("https://otinstaller.com/docs/"), "otinstaller.com")?.status).toBe(301);
  });
  it("does not touch other hosts", () => {
    expect(to("http://staging.example.com/docs")).toBeNull();
  });
});
