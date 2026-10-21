# The registry's scanner with all its tools, for running scans locally exactly as CI does:
#   docker build -t otinstaller-scanner ops/scanner
#   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/req.json:/req.json" otinstaller-scanner /req.json
FROM python:3.12-slim

ARG TRIVY_VERSION=0.76.0
ARG COSIGN_VERSION=3.1.3
ARG DOCKER_VERSION=29.9.1
ARG CRANE_VERSION=0.20.6

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
 && curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" | tar -xz -C /usr/local/bin trivy \
 && curl -fsSLo /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64" \
 && chmod +x /usr/local/bin/cosign \
 && curl -fsSL "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" | tar -xz -C /usr/local/bin crane \
 && pip install --no-cache-dir guarddog==3.2.0 cryptography==50.0.2

COPY scan.py backup.py /usr/local/bin/
ENTRYPOINT ["python3", "/usr/local/bin/scan.py"]
