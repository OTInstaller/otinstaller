FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/sensepost/gowitness@3.2.2

FROM alpine:3.22
RUN apk add --no-cache ca-certificates chromium font-liberation
COPY --from=build /go/bin/gowitness /usr/local/bin/gowitness
USER 65534
WORKDIR /tmp
ENTRYPOINT ["gowitness"]
