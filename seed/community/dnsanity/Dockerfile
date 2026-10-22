FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/nil0x42/dnsanity@v1.4.2

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/dnsanity /usr/local/bin/dnsanity
USER 65534
WORKDIR /tmp
ENTRYPOINT ["dnsanity"]
