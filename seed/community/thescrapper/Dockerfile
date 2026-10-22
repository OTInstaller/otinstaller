FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/champmq/TheScrapper.git /opt/tool && git -C /opt/tool checkout --quiet de4b51d20bd80a147b9dde33f5e31d8fbabc3705 && pip install --no-cache-dir requests beautifulsoup4 socid-extractor
USER app
WORKDIR /opt/tool
ENTRYPOINT ["python", "/opt/tool/TheScrapper.py"]
