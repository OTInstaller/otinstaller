FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY companies_house_lookup.py /usr/local/bin/companies-house
RUN chmod 755 /usr/local/bin/companies-house
USER app
ENTRYPOINT ["companies-house"]
