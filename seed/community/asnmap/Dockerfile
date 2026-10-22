FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/asnmap/cmd/asnmap@v1.1.1

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/asnmap /usr/local/bin/asnmap
USER 65534
ENTRYPOINT ["asnmap"]
