FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY phone_parse.py /usr/local/bin/phone-parse
RUN chmod 755 /usr/local/bin/phone-parse
USER app
ENTRYPOINT ["phone-parse"]
