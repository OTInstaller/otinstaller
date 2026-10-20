FROM golang:1.26-alpine AS build
RUN apk add --no-cache build-base libpcap-dev
RUN CGO_ENABLED=1 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/naabu/v2/cmd/naabu@v2.6.1

FROM alpine:3.22
RUN apk add --no-cache ca-certificates libpcap
COPY --from=build /go/bin/naabu /usr/local/bin/naabu
USER 65534
ENTRYPOINT ["naabu"]
