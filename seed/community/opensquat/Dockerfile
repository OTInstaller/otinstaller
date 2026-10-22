FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir opensquat==2.3.0
USER app
WORKDIR /tmp
ENTRYPOINT ["opensquat"]
