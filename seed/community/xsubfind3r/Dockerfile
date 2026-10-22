FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/hueristiq/xsubfind3r.git /src && git -C /src checkout --quiet eace325a1d654a37064e5f1e2845d4d81335d537 && cd /src && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /go/bin/xsubfind3r ./cmd/xsubfind3r

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/xsubfind3r /usr/local/bin/xsubfind3r
USER 65534
WORKDIR /tmp
ENTRYPOINT ["xsubfind3r"]
