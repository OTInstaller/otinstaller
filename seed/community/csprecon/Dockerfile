FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/edoardottt/csprecon/cmd/csprecon@v0.4.7

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/csprecon /usr/local/bin/csprecon
USER 65534
ENTRYPOINT ["csprecon"]
