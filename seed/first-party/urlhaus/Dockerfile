FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY urlhaus.py /usr/local/bin/urlhaus
RUN chmod 755 /usr/local/bin/urlhaus
USER app
ENTRYPOINT ["urlhaus"]
