FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/az7rb/crt.sh/v3@v3.0.4

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/crt.sh /usr/local/bin/crt.sh
USER 65534
ENTRYPOINT ["crt.sh"]
