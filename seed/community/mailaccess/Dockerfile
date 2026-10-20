FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir "mailaccess==0.18.7" "mailaccess[browser]==0.18.7" "playwright>=1.49"
RUN python -m playwright install --with-deps --only-shell chromium
USER app
ENTRYPOINT ["mailaccess"]
