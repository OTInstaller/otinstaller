FROM python:3.12-slim
COPY dns_lookup.py /usr/local/bin/dns-lookup
RUN chmod 0755 /usr/local/bin/dns-lookup && sed -i '1i #!/usr/bin/env python3' /usr/local/bin/dns-lookup
ENTRYPOINT ["dns-lookup"]
