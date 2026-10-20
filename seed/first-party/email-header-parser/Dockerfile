FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY email_header_parser.py /usr/local/bin/email-header-parser
RUN chmod 755 /usr/local/bin/email-header-parser
USER app
ENTRYPOINT ["email-header-parser"]
