FROM python:3.13-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir pygleif==2026.7.3
USER app
ENTRYPOINT ["pygleif"]
