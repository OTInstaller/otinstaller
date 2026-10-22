FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/karust/gogetcrawl@v1.1.3

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/gogetcrawl /usr/local/bin/gogetcrawl
USER 65534
WORKDIR /tmp
ENTRYPOINT ["gogetcrawl"]
