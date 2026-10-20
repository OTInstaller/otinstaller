FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY geo_links.py /usr/local/bin/geo-links
RUN chmod 755 /usr/local/bin/geo-links
USER app
ENTRYPOINT ["geo-links"]
