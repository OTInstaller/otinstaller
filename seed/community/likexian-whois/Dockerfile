FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/likexian/whois/cmd/whois@v1.15.7

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/whois /usr/local/bin/whois
USER 65534
ENTRYPOINT ["whois"]
