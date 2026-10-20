FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY dns_records.py /usr/local/bin/dns-records
RUN chmod 755 /usr/local/bin/dns-records
USER app
ENTRYPOINT ["dns-records"]
