FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY hunter_domain_search.py /usr/local/bin/hunter-domain-search
RUN chmod 755 /usr/local/bin/hunter-domain-search
USER app
ENTRYPOINT ["hunter-domain-search"]
