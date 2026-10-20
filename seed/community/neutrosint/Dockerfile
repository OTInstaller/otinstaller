FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/Kr0wZ/NeutrOSINT@a51a133444c366ea3a60a8c400a3624625d79e6d
USER app
ENTRYPOINT ["neutrosint"]
