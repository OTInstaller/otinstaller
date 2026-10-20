FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir shodan==1.31.0
COPY shodan_host.sh /usr/local/bin/shodan-host
RUN chmod 755 /usr/local/bin/shodan-host
USER app
ENTRYPOINT ["shodan-host"]
