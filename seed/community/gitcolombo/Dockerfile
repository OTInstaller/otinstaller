FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir gitcolombo==0.3.0
USER app
WORKDIR /tmp
ENTRYPOINT ["gitcolombo"]
