FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY opensanctions.py /usr/local/bin/opensanctions
RUN chmod 755 /usr/local/bin/opensanctions
USER app
ENTRYPOINT ["opensanctions"]
