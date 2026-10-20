FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home app
RUN git clone --quiet https://github.com/thewhiteh4t/FinalRecon.git /opt/finalrecon && git -C /opt/finalrecon checkout --quiet b5db3a46921195bec643065c560e19741852957c && pip install --no-cache-dir -r /opt/finalrecon/requirements.txt
WORKDIR /opt/finalrecon
USER app
ENTRYPOINT ["python", "/opt/finalrecon/finalrecon.py"]
