FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir pysafebrowsing==0.1.4
COPY safebrowsing_url.sh /usr/local/bin/safebrowsing-url
RUN chmod 755 /usr/local/bin/safebrowsing-url
USER app
ENTRYPOINT ["safebrowsing-url"]
