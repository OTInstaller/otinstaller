FROM rust:1.98-alpine AS build
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconfig && cargo install --locked urx --version 0.11.0

FROM alpine:3.22
RUN apk add --no-cache ca-certificates libgcc openssl
COPY --from=build /usr/local/cargo/bin/urx /usr/local/bin/urx
USER 65534
ENTRYPOINT ["urx"]
