FROM alpine:3.22 AS download
ARG TARGETARCH
RUN apk add --no-cache curl
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) file=phoneinfoga_Linux_x86_64.tar.gz; sum=6173dfc4ec009a6fe688068bac5a250646f5a8f56409098f5edcc7e404b12a52 ;; \
      arm64) file=phoneinfoga_Linux_arm64.tar.gz; sum=bc8ed51e3e20fe4b82999aac16a7925f783562346563ba4b26e33c90434cd58b ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/p.tar.gz "https://github.com/sundowndev/phoneinfoga/releases/download/v2.11.0/$file"; \
    echo "$sum  /tmp/p.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/p.tar.gz -C /usr/local/bin phoneinfoga

FROM alpine:3.22
RUN apk add --no-cache ca-certificates libc6-compat
COPY --from=download /usr/local/bin/phoneinfoga /usr/local/bin/phoneinfoga
USER 65534
ENTRYPOINT ["phoneinfoga"]
