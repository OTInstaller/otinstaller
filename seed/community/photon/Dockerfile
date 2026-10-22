FROM python:3.10-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/s0md3v/Photon.git /opt/photon && git -C /opt/photon checkout --quiet c8d2566841d69a268b244609921143d84b72b0c6 && pip install --no-cache-dir -r /opt/photon/requirements.txt
USER app
WORKDIR /tmp
ENTRYPOINT ["python", "/opt/photon/photon.py"]
