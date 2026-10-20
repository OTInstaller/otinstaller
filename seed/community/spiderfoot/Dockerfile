FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/smicallef/spiderfoot.git /opt/spiderfoot && git -C /opt/spiderfoot checkout --quiet 0f815a203afebf05c98b605dba5cf0475a0ee5fd && pip install --no-cache-dir -r /opt/spiderfoot/requirements.txt
WORKDIR /opt/spiderfoot
USER app
ENTRYPOINT ["python", "/opt/spiderfoot/sf.py"]
