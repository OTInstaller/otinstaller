FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/UnaPibaGeek/ctfr.git /opt/ctfr && git -C /opt/ctfr checkout --quiet 6c7fecdc6346c4f5322049e38f415d5bddaa420d && pip install --no-cache-dir -r /opt/ctfr/requirements.txt
USER app
WORKDIR /tmp
ENTRYPOINT ["python", "/opt/ctfr/ctfr.py"]
