FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/hueristiq/xcrawl3r.git /src && git -C /src checkout --quiet 91fe2d7adf323903d47eba33b74fcd11de3fb959 && cd /src && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /go/bin/xcrawl3r ./cmd/xcrawl3r

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/xcrawl3r /usr/local/bin/xcrawl3r
USER 65534
WORKDIR /tmp
ENTRYPOINT ["xcrawl3r"]
