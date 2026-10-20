FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY username_permutations.py /usr/local/bin/username-permutations
RUN chmod 755 /usr/local/bin/username-permutations
USER app
ENTRYPOINT ["username-permutations"]
