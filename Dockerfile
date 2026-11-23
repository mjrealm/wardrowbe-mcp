FROM python:3.12-slim AS build
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.12-slim
# Run as an unprivileged user. /data holds the saved sign-in state, so mount a volume there.
RUN useradd --system --uid 10001 --home-dir /data wardrowbe && mkdir -p /data && chown wardrowbe /data
COPY --from=build /install /usr/local
USER wardrowbe
ENV MCP_BIND_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    WARDROWBE_TOKEN_FILE=/data/refresh-token.json \
    WARDROWBE_STATE_FILE=/data/oauth-state.json \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('MCP_PORT','8080')+'/healthz')"
CMD ["wardrowbe-mcp"]
