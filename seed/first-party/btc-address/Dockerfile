FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY btc_address.py /usr/local/bin/btc-address
RUN chmod 755 /usr/local/bin/btc-address
USER app
ENTRYPOINT ["btc-address"]
