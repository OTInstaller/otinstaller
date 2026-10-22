FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/003random/getJS/v2@v2.0.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/getJS /usr/local/bin/getJS
USER 65534
ENTRYPOINT ["getJS"]
