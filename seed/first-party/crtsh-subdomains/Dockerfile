FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY crtsh_subdomains.py /usr/local/bin/crtsh-subdomains
RUN chmod 755 /usr/local/bin/crtsh-subdomains
USER app
ENTRYPOINT ["crtsh-subdomains"]
