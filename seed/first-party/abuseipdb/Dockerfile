FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY abuseipdb.py /usr/local/bin/abuseipdb
RUN chmod 755 /usr/local/bin/abuseipdb
USER app
ENTRYPOINT ["abuseipdb"]
