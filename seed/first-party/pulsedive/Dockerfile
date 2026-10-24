FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY pulsedive.py /usr/local/bin/pulsedive
RUN chmod 755 /usr/local/bin/pulsedive
USER app
ENTRYPOINT ["pulsedive"]
