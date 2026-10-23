// The Dockerfile templates the import wizard offers when a community wrapper builds its own image. The API checks
// every Dockerfile against the same rules (api/src/submissions.ts:dockerfileChecks, whose tests also run these
// templates): official base images pinned by tag, a non-root user, and the upstream release pinned with
// ARG UPSTREAM_VERSION so bump pull requests change one line. No imports, so the API's tests can load it.

export type TemplateKind = "go" | "pip" | "pip_git";

export const TEMPLATE_LABEL: Record<TemplateKind, string> = {
  go: "Go: go install the module",
  pip: "Python: pip install from PyPI",
  pip_git: "Python: pip install from the repository",
};

/**
 * A Dockerfile that builds the upstream project at its release, runs as an unprivileged user and starts the tool.
 * `repo` is the upstream's host and path (github.com/owner/tool), `command` what the tool's binary is called.
 */
export function dockerfileTemplate(kind: TemplateKind, o: { repo: string; version: string; command: string; pkg?: string }): string {
  const version = o.version.replace(/^v/, "");
  if (kind === "go") {
    return [
      "FROM golang:1.26-alpine AS build",
      `ARG UPSTREAM_VERSION=${version}`,
      `RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' ${o.repo}@v\${UPSTREAM_VERSION}`,
      "",
      "FROM alpine:3.22",
      "RUN apk add --no-cache ca-certificates",
      `COPY --from=build /go/bin/${o.command} /usr/local/bin/${o.command}`,
      "USER 65534",
      `ENTRYPOINT ["${o.command}"]`,
      "",
    ].join("\n");
  }
  const source = kind === "pip" ? `"${o.pkg ?? o.command}==\${UPSTREAM_VERSION}"` : `"git+https://${o.repo}@v\${UPSTREAM_VERSION}"`;
  return [
    "FROM python:3.12-slim",
    `ARG UPSTREAM_VERSION=${version}`,
    "RUN useradd --uid 10001 --create-home app",
    `RUN pip install --no-cache-dir ${source}`,
    "USER app",
    "WORKDIR /tmp",
    `ENTRYPOINT ["${o.command}"]`,
    "",
  ].join("\n");
}
