FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY shodan_internetdb.py /usr/local/bin/shodan-internetdb
RUN chmod 755 /usr/local/bin/shodan-internetdb
USER app
ENTRYPOINT ["shodan-internetdb"]
