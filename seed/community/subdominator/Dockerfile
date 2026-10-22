FROM python:3.13-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir subdominator==3.0.3
USER app
WORKDIR /tmp
ENTRYPOINT ["subdominator"]
