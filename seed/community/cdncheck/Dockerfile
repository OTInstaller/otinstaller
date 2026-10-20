FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/cdncheck/cmd/cdncheck@v1.3.2

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/cdncheck /usr/local/bin/cdncheck
USER 65534
ENTRYPOINT ["cdncheck"]
