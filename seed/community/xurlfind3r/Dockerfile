FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/hueristiq/xurlfind3r.git /src && git -C /src checkout --quiet be80a0c7cd049f0d8ca7487ff1dce142b6298d16 && cd /src && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /go/bin/xurlfind3r ./cmd/xurlfind3r

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/xurlfind3r /usr/local/bin/xurlfind3r
USER 65534
ENTRYPOINT ["xurlfind3r"]
