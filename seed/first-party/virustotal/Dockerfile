FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY virustotal.py /usr/local/bin/virustotal
RUN chmod 755 /usr/local/bin/virustotal
USER app
ENTRYPOINT ["virustotal"]
