FROM python:3.12-slim
# naminter's report export uses WeasyPrint, which loads Pango at import time.
RUN apt-get update && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b     && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir naminter==1.0.9
USER app
ENTRYPOINT ["naminter"]
