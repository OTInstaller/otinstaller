FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir instaloader==4.15.4
COPY instaloader_profile.py /usr/local/bin/instaloader-profile
RUN chmod 755 /usr/local/bin/instaloader-profile
USER app
ENTRYPOINT ["instaloader-profile"]
