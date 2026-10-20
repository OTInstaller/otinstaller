FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/lc/gau/v2/cmd/gau@v2.2.4

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/gau /usr/local/bin/gau
USER 65534
ENTRYPOINT ["gau"]
