FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/XORbit01/webpalm/v2@v2.0.20

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/webpalm /usr/local/bin/webpalm
USER 65534
ENTRYPOINT ["webpalm"]
