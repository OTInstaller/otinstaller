FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY hibp_breaches.py /usr/local/bin/hibp-breaches
RUN chmod 755 /usr/local/bin/hibp-breaches
USER app
ENTRYPOINT ["hibp-breaches"]
