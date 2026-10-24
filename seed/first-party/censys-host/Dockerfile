FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY censys_host.py /usr/local/bin/censys-host
RUN chmod 755 /usr/local/bin/censys-host
USER app
ENTRYPOINT ["censys-host"]
