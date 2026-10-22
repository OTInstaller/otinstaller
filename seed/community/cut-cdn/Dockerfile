FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/ImAyrix/cut-cdn.git /src && cd /src && git checkout --quiet 2105f012651aaa770a1b3d73d1b96b418813b1dc && go get github.com/modern-go/reflect2@v1.0.2 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/cut-cdn .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/cut-cdn /usr/local/bin/cut-cdn
USER 65534
ENTRYPOINT ["cut-cdn"]
