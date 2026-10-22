FROM golang:1.26-alpine AS build
RUN CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' github.com/projectdiscovery/shuffledns/cmd/shuffledns@v1.2.1

FROM alpine:3.22 AS massdns
RUN apk add --no-cache build-base git
RUN git clone --quiet https://github.com/blechschmidt/massdns.git /src && git -C /src checkout --quiet 30c380908b4f9afd0931d3d83f85884844831846 && make -C /src

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /go/bin/shuffledns /usr/local/bin/shuffledns
COPY --from=massdns /src/bin/massdns /usr/local/bin/massdns
RUN mkdir -p /opt/shuffledns && printf '1.1.1.1\n1.0.0.1\n8.8.8.8\n8.8.4.4\n9.9.9.9\n149.112.112.112\n208.67.222.222\n208.67.220.220\n' > /opt/shuffledns/resolvers.txt && wget -q -O /opt/shuffledns/wordlist.txt https://raw.githubusercontent.com/danielmiessler/SecLists/10a38f6cbe8ed6b89d55348756eff7486cd0f0ea/Discovery/DNS/subdomains-top1million-5000.txt
USER 65534
WORKDIR /tmp
ENTRYPOINT ["shuffledns"]
