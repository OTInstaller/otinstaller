FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY reverse_image_links.py /usr/local/bin/reverse-image-links
RUN chmod 755 /usr/local/bin/reverse-image-links
USER app
ENTRYPOINT ["reverse-image-links"]
