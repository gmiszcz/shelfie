# syntax=docker/dockerfile:1
# Multi-stage, multi-arch. The Vite bundle is plain static files, so the Node
# stage runs on the native builder (BUILDPLATFORM) instead of under QEMU. Only
# the Python runtime stage is cross-built for the target platforms.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Cap the V8 heap for constrained builders; override with --build-arg.
ARG NODE_OPTIONS=--max-old-space-size=900
ENV NODE_OPTIONS=${NODE_OPTIONS}
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
# scripts/_dataio.py is imported at runtime by app/services/books_json.py.
COPY scripts ./scripts
COPY --from=web /src/frontend/dist ./frontend/dist
# All data paths are relative ("data/..."), so the persistent volume mounts at
# /app/data (see fly.toml [mounts]).
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; port = os.environ.get('PORT', '8000'); urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health')"
CMD ["python", "-m", "app"]
