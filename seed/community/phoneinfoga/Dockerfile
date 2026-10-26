FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --depth 1 --branch v2.11.0 https://github.com/sundowndev/phoneinfoga /src
WORKDIR /src
# Upstream's release binary was built with Go 1.20 and dependencies that have known vulnerabilities, so build it again
# with current ones. The web interface it embeds is built with Node and not in the repository; `phoneinfoga scan`
# doesn't use it, so a placeholder page stands in.
RUN mkdir -p web/client/dist && echo '<!doctype html><title>PhoneInfoga</title>' > web/client/dist/index.html
RUN go get golang.org/x/crypto@v0.58.0 golang.org/x/net@v0.61.0 golang.org/x/text@v0.43.0 golang.org/x/oauth2@v0.37.0 \
      google.golang.org/grpc@v1.84.0 github.com/sirupsen/logrus@v1.10.2 github.com/gin-gonic/gin@v1.12.0 && go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -X github.com/sundowndev/phoneinfoga/v2/build.Version=v2.11.0' \
      -o /usr/local/bin/phoneinfoga .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /usr/local/bin/phoneinfoga /usr/local/bin/phoneinfoga
USER 65534
ENTRYPOINT ["phoneinfoga"]
