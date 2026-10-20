FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN pip install --no-cache-dir git+https://github.com/aboul3la/Sublist3r@729d649ec5370730172bf6f5314aafd68c874124
USER app
WORKDIR /tmp
ENTRYPOINT ["sublist3r"]
