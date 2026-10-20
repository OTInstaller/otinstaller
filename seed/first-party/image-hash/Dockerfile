FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY image_hash.py /usr/local/bin/image-hash
RUN chmod 755 /usr/local/bin/image-hash
USER app
ENTRYPOINT ["image-hash"]
