FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/whoamitang/numint@9186c35ad0836e8094bfa1a0e264fe6e01a82823
USER app
WORKDIR /tmp
ENTRYPOINT ["numint"]
