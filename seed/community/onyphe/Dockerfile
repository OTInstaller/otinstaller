FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir "pyonyphe[cli]==3.1.1"
USER app
ENTRYPOINT ["pyonyphe"]
