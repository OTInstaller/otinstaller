FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/tlsx/cmd/tlsx@v1.4.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/tlsx /usr/local/bin/tlsx
USER 65534
ENTRYPOINT ["tlsx"]
