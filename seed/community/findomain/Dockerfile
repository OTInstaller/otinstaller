FROM rust:1.90-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev git && rm -rf /var/lib/apt/lists/*
RUN cargo install --locked --git https://github.com/Findomain/Findomain --tag 10.0.1 findomain

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/cargo/bin/findomain /usr/local/bin/findomain
USER 65534
WORKDIR /tmp
ENTRYPOINT ["findomain"]
