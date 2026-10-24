FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY otx_indicators.py /usr/local/bin/otx-indicators
RUN chmod 755 /usr/local/bin/otx-indicators
USER app
ENTRYPOINT ["otx-indicators"]
