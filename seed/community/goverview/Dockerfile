FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/j3ssie/goverview@v1.0.1

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/goverview /usr/local/bin/goverview
USER 65534
WORKDIR /tmp
ENTRYPOINT ["goverview"]
