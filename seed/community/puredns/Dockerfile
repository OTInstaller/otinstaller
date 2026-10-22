FROM golang:1.26-alpine AS build
RUN apk add --no-cache git build-base
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/d3mondev/puredns/v2@v2.1.1
RUN git clone --quiet https://github.com/blechschmidt/massdns.git /src/massdns && git -C /src/massdns checkout --quiet v1.1.0 && make -C /src/massdns
RUN mkdir -p /opt/puredns && wget -q -O /opt/puredns/subdomains-top5000.txt https://raw.githubusercontent.com/danielmiessler/SecLists/10a38f6cbe8ed6b89d55348756eff7486cd0f0ea/Discovery/DNS/subdomains-top1million-5000.txt && printf '1.1.1.1\n1.0.0.1\n8.8.8.8\n8.8.4.4\n9.9.9.9\n149.112.112.112\n208.67.222.222\n208.67.220.220\n' > /opt/puredns/resolvers.txt && chmod 0755 /opt/puredns && chmod 0644 /opt/puredns/*

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/puredns /usr/local/bin/puredns
COPY --from=build /src/massdns/bin/massdns /usr/local/bin/massdns
COPY --from=build /opt/puredns /opt/puredns
USER 65534
WORKDIR /tmp
ENTRYPOINT ["puredns"]
