FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY urlscan_search.py /usr/local/bin/urlscan-search
RUN chmod 755 /usr/local/bin/urlscan-search
USER app
ENTRYPOINT ["urlscan-search"]
