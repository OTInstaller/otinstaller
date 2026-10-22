FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/soxoj/marple.git /opt/tool && git -C /opt/tool checkout --quiet 4c3313642088036c078fc2c82767c112c6c50d3e && pip install --no-cache-dir git+https://github.com/soxoj/Search-Engines-Scraper@3dde3058acb212f0dbf67d2e313fae4c767d5e91 termcolor==3.3.0 requests==2.34.2 yandex-search==0.3.2 PyPDF2==3.0.1 socid-extractor==0.1.1 tqdm==4.70.1 google-search-results==2.4.2 mock==5.2.0 arabic-reshaper==3.0.1
USER app
WORKDIR /tmp
ENTRYPOINT ["python", "/opt/tool/marple.py"]
