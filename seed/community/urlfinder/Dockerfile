FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/urlfinder/cmd/urlfinder@v0.0.3

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/urlfinder /usr/local/bin/urlfinder
USER 65534
ENTRYPOINT ["urlfinder"]
