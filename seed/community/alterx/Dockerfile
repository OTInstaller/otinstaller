FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/alterx/cmd/alterx@v0.1.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/alterx /usr/local/bin/alterx
USER 65534
ENTRYPOINT ["alterx"]
