FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
COPY exif_meta.py /usr/local/bin/exif-meta
RUN chmod 755 /usr/local/bin/exif-meta
USER app
ENTRYPOINT ["exif-meta"]
