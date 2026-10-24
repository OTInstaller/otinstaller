FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY sec_edgar.py /usr/local/bin/sec-edgar
RUN chmod 755 /usr/local/bin/sec-edgar
USER app
ENTRYPOINT ["sec-edgar"]
