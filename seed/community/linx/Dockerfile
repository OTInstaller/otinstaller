FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/riza/linx/cmd/linx@v0.2.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && mkdir -p /opt/linx && ln -s /dev/stdout /opt/linx/stdout.json
COPY --from=build /go/bin/linx /usr/local/bin/linx
USER 65534
ENTRYPOINT ["linx"]
