FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --depth 1 --branch v2.17.0 https://github.com/projectdiscovery/subfinder /src
WORKDIR /src
# Raise the dependencies with known vulnerabilities to their fixed releases, which `go install` can't do.
RUN go get github.com/klauspost/compress@v1.18.7 golang.org/x/net@v0.61.0 && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /go/bin/subfinder ./cmd/subfinder

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/subfinder /usr/local/bin/subfinder
USER 65534
ENTRYPOINT ["subfinder"]
