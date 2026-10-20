FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir holehe==1.61
USER app
ENTRYPOINT ["holehe"]
