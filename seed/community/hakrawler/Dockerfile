# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/hakluke/hakrawler@52a16fe61bd18b8f431b9d66058cba12e96e4451

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/hakrawler /usr/local/bin/hakrawler
# hakrawler only reads URLs from stdin; this passes the first argument to it as that input.
COPY --chmod=755 <<'EOF' /usr/local/bin/hakrawler-url
#!/bin/sh
url="$1"
shift
printf '%s\n' "$url" | hakrawler "$@"
EOF
USER 65534
ENTRYPOINT ["hakrawler-url"]
