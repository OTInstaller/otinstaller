FROM alpine:3.22 AS build
RUN apk add --no-cache build-base perl pkgconf libidn2-dev git
RUN git clone --quiet https://github.com/rfc1036/whois.git /src && git -C /src checkout --quiet 1024386831c8ee4e0ae24026fa932771bf369fe9 && make -C /src whois

FROM alpine:3.22
RUN apk add --no-cache libidn2
COPY --from=build /src/whois /usr/local/bin/whois
USER 65534
ENTRYPOINT ["whois"]
