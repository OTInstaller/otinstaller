FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/laramies/theHarvester@4.11.1
# theHarvester 4.11.1 pins aiohttp 3.14.0 and certifi 2026.5.20, which have known vulnerabilities; these releases fix them.
RUN pip install --no-cache-dir "aiohttp==3.14.5" "certifi==2026.10.23"
USER app
ENTRYPOINT ["theHarvester"]
