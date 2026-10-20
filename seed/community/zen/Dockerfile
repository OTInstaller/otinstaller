FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/s0md3v/Zen.git /opt/zen && git -C /opt/zen checkout --quiet b9018b4b74eb0cb64d5a61ff00cdd413cf5d7733 && pip install --no-cache-dir -r /opt/zen/requirements.txt
WORKDIR /opt/zen
USER app
ENTRYPOINT ["python", "/opt/zen/zen.py"]
