FROM golang:1.27-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/praetorian-inc/nerva/cmd/nerva@v1.77.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/nerva /usr/local/bin/nerva
USER 65534
ENTRYPOINT ["nerva"]
