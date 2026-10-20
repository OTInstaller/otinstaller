FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/subfinder/v2/cmd/subfinder@v2.17.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/subfinder /usr/local/bin/subfinder
USER 65534
ENTRYPOINT ["subfinder"]
