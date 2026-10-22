FROM alpine:3.22
RUN apk add --no-cache aha bash bind-tools coreutils curl grepcidr3 ipcalc jq mtr ncurses nmap nmap-ncat whois ca-certificates
RUN curl -fsSL -o /usr/local/bin/asn https://raw.githubusercontent.com/nitefood/asn/v0.83.0/asn && chmod 0755 /usr/local/bin/asn
RUN printf '%s\n' '#!/usr/bin/env bash' 'mkdir -p "$HOME/.asn"' 'if [ -n "$IQS_TOKEN" ]; then printf "%s" "$IQS_TOKEN" > "$HOME/.asn/iqs_token"; fi' 'if [ -n "$IPINFO_TOKEN" ]; then printf "%s" "$IPINFO_TOKEN" > "$HOME/.asn/ipinfo_token"; fi' 'if [ -n "$CLOUDFLARE_TOKEN" ]; then printf "%s" "$CLOUDFLARE_TOKEN" > "$HOME/.asn/cloudflare_token"; fi' 'exec /usr/local/bin/asn "$@"' > /usr/local/bin/asn-ot && chmod 0755 /usr/local/bin/asn-ot
USER 65534
WORKDIR /tmp
ENTRYPOINT ["asn-ot"]
