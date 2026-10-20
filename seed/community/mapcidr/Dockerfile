FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/mapcidr/cmd/mapcidr@v1.1.97

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/mapcidr /usr/local/bin/mapcidr
USER 65534
ENTRYPOINT ["mapcidr"]
