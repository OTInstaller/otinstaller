FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/devanshbatham/ParamSpider@c44bdaae54789b237028e309b603d1aa5ad52e5e
USER app
ENTRYPOINT ["paramspider"]
