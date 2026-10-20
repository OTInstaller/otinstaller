FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY eth_address.py /usr/local/bin/eth-address
RUN chmod 755 /usr/local/bin/eth-address
USER app
ENTRYPOINT ["eth-address"]
