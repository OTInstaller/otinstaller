FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir "dnspython==2.7.0" git+https://github.com/cisagov/findcdn@7bbf50e4a1cf1f32999c1abdcabc064d8ebf53f8
USER app
WORKDIR /tmp
ENTRYPOINT ["findcdn"]
