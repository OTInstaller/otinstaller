FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir ipdata==4.0.9
COPY ipdata_lookup.sh /usr/local/bin/ipdata-lookup
RUN chmod 755 /usr/local/bin/ipdata-lookup
USER app
ENTRYPOINT ["ipdata-lookup"]
