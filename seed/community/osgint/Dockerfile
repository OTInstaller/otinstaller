FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/hippiiee/osgint.git /opt/tool && git -C /opt/tool checkout --quiet 866a08b41d12591a97686dd37106b8b812799ec4 && pip install --no-cache-dir -r /opt/tool/requirements.txt
USER app
WORKDIR /tmp
ENTRYPOINT ["python", "/opt/tool/osgint.py"]
