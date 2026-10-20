FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir "aliens_eye==2.7.0" "selectolax<0.4"
USER app
ENTRYPOINT ["aliens_eye"]
