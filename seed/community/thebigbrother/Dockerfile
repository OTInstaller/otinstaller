FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/chadi0x/TheBigBrother@96e03c34d415aaeaddd66d54bb2e2359d4b320fc
USER app
ENTRYPOINT ["python", "-m", "the_big_brother"]
