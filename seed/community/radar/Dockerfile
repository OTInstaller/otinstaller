FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/Elite-Security-Systems/radar.git /src && git -C /src checkout --quiet 08110d51af9ddce6b804e9e685474de29cb26e50
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -X main.Version=v0.1.1' -o /go/bin/radar ./cmd/radar

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/radar /usr/local/bin/radar
COPY --from=build /src/data/signatures.json /usr/share/radar/signatures.json
USER 65534
WORKDIR /tmp
ENTRYPOINT ["radar"]
