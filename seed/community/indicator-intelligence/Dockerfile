FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/OsmanKandemir/indicator-intelligence.git /opt/tool && git -C /opt/tool checkout --quiet 81f24e0a6b72da87570bf8e27195c3b0007a15a6 && pip install --no-cache-dir -r /opt/tool/requirements.txt
USER app
WORKDIR /tmp
ENTRYPOINT ["python", "/opt/tool/indicator/indicator.py"]
