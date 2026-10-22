FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/initstring/cloud_enum@21af4f9b0899bebb8f0b6dd4c0839eec33d2bb19
USER app
WORKDIR /tmp
ENTRYPOINT ["cloud_enum"]
