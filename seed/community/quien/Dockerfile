FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/retlehs/quien@v0.12.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/quien /usr/local/bin/quien
USER 65534
ENTRYPOINT ["quien"]
