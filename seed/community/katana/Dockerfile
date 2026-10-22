FROM golang:1.26-alpine AS build
RUN apk add --no-cache gcc musl-dev
RUN CGO_ENABLED=1 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/katana/cmd/katana@v1.8.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/katana /usr/local/bin/katana
USER 65534
ENTRYPOINT ["katana"]
