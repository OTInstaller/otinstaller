FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet --depth 1 --branch v2.2.0 https://github.com/j3ssie/metabigor.git /src && cd /src && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/metabigor ./cmd/metabigor

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/metabigor /usr/local/bin/metabigor
USER 65534
ENTRYPOINT ["metabigor"]
