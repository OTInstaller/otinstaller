FROM python:3.13-slim
RUN useradd --uid 10001 --create-home app
# octosuite 5.1.0 imports requests without declaring it, and calls update-checker's pre-1.0 API.
RUN pip install --no-cache-dir octosuite==5.1.0 requests==2.34.2 update-checker==0.18.0
USER app
WORKDIR /tmp
ENTRYPOINT ["octosuite"]
