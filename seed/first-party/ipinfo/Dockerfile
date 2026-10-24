FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY ipinfo_lookup.py /usr/local/bin/ipinfo
RUN chmod 755 /usr/local/bin/ipinfo
USER app
ENTRYPOINT ["ipinfo"]
