FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir ipwhois==1.3.0
COPY ipwhois-rdap /usr/local/bin/ipwhois-rdap
RUN chmod 755 /usr/local/bin/ipwhois-rdap
USER app
ENTRYPOINT ["ipwhois-rdap"]
