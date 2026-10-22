FROM golang:1.26-alpine AS build
RUN apk add --no-cache git
RUN git clone --quiet https://github.com/tdh8316/Investigo.git /src && git -C /src checkout --quiet 3ed07ede39626721aa5869caad6d3ce80f7a0053
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/investigo ./cmd/investigo

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/investigo /usr/local/bin/investigo
COPY --from=build /src/data.json /opt/investigo/data.json
USER 65534
WORKDIR /tmp
ENTRYPOINT ["investigo"]
