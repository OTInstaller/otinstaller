FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/uncover/cmd/uncover@v1.2.1

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/uncover /usr/local/bin/uncover
USER 65534
ENTRYPOINT ["uncover"]
