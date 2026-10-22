FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/edoardottt/favirecon/cmd/favirecon@v1.0.4

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/favirecon /usr/local/bin/favirecon
USER 65534
ENTRYPOINT ["favirecon"]
