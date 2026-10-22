FROM python:3.13-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir octosuite==5.1.0
USER app
WORKDIR /tmp
ENTRYPOINT ["octosuite"]
