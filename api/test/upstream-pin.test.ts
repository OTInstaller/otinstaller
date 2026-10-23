// The Dockerfile pin parser: every community wrapper in the seed names the upstream release it builds.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { findPin } from "../src/upstream-pin";

type Wrapper = { name: string; homepage: string; dockerfile: string };
const WRAPPERS = (env as unknown as { TEST_DOCKERFILES: Wrapper[] }).TEST_DOCKERFILES;

describe("upstream pins", () => {
  it("finds the upstream pin in every seed wrapper's Dockerfile", () => {
    expect(WRAPPERS.length).toBeGreaterThan(50);
    const missing = WRAPPERS.filter((w) => !findPin(w.dockerfile, w.homepage)).map((w) => w.name);
    expect(missing).toEqual([]);
  });

  it("reads each way of pinning", () => {
    const up = "https://github.com/owner/tool";
    expect(findPin("FROM golang:1.26-alpine AS b\nRUN go install -trimpath github.com/owner/tool/v2/cmd/tool@v2.3.1\n", up)).toMatchObject({ kind: "go", ref: "v2.3.1", line: 2 });
    expect(findPin("FROM python:3.12-slim\nRUN pip install --no-cache-dir \"Tool==1.4\" \"requests==2.0\"\n", up)).toMatchObject({ kind: "pip", ref: "1.4", package: "Tool" });
    expect(findPin("FROM python:3.12-slim\nRUN pip install git+https://github.com/owner/tool@0123456789abcdef0123456789abcdef01234567\n", up)).toMatchObject({ kind: "pip_git", ref: "0123456789abcdef0123456789abcdef01234567" });
    expect(findPin("FROM alpine:3.22\nRUN git clone --quiet https://github.com/owner/tool.git /src && \\n  git -C /src checkout --quiet v1.0\n", up)).toMatchObject({ kind: "git", ref: "v1.0", line: 2 });
    expect(findPin("FROM rust:1.90-slim\nRUN cargo install --locked --git https://github.com/owner/tool --tag 10.0.1 tool\n", up)).toMatchObject({ kind: "cargo_git", ref: "10.0.1" });
    expect(findPin("FROM alpine:3.22\nARG UPSTREAM_VERSION=1.2.3\nRUN go install github.com/owner/tool@v${UPSTREAM_VERSION}\n", up)).toMatchObject({ kind: "arg", ref: "1.2.3", line: 2 });
    expect(findPin("FROM alpine:3.22\nRUN curl -fsSLo /t.tgz https://github.com/owner/tool/releases/download/v2.11.0/tool_linux.tgz\n", up)).toMatchObject({ kind: "release_url", ref: "v2.11.0" });
    // Another project's pin is not the upstream's.
    expect(findPin("FROM golang:1.26-alpine\nRUN go install github.com/someone/else@v1.0.0\n", up)).toBeNull();
  });
});
