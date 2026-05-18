# ============================================================================
# Satori v2 — Production container image (3-stage)
# ============================================================================
#   1. frontend-builder — Node 20 runs `npm ci && npm run build` → /frontend/dist
#   2. python-builder   — uv installs Python deps into /pyroot (flat target dir)
#   3. runtime          — Google distroless Python 3.11 (nonroot), gunicorn on port 8080
#
# Self-contained: every `git push` rebuilds React + backend deps from source.
# No need to remember `npm run build` locally.
# ============================================================================

# ─── Stage 1: frontend-builder ───────────────────────────────────────────────
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund || npm install --no-audit --no-fund ; \
    else \
        npm install --no-audit --no-fund ; \
    fi
COPY frontend/ ./
RUN npm run build

# ─── Stage 2: python-builder ─────────────────────────────────────────────────
FROM python:3.11-slim AS python-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps for wheels that compile from source (grpc, pandas, psycopg2)
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential gcc libpq-dev \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "uv>=0.4.0"

WORKDIR /build
COPY backend/requirements.txt ./

# Install into /pyroot as a flat package directory — distroless picks it up
# via PYTHONPATH. Avoids the venv-symlink footgun.
RUN uv pip install --python "$(which python)" --target /pyroot --no-cache \
        -r requirements.txt \
        gunicorn \
        uvicorn[standard]

# ─── Stage 3: runtime (distroless) ───────────────────────────────────────────
# python3-debian12 is Python 3.11 — matches the builder. We need the libpq
# shared library for psycopg2 at runtime; the distroless variant does not
# include it, so we use distroless cc-debian12:nonroot which lets us bring
# any extra .so files. For TMC v1 we use python3-debian12:nonroot and copy
# the libpq library from the python-builder stage so Postgres works.
FROM gcr.io/distroless/python3-debian12:nonroot AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/pyroot:/app \
    PORT=8080

# Python packages.
COPY --from=python-builder --chown=nonroot:nonroot /pyroot /pyroot

# Application source — exclude data, secrets, frontend node_modules via .dockerignore.
COPY --chown=nonroot:nonroot backend/ /app/

# React build artefacts.
COPY --from=frontend-builder --chown=nonroot:nonroot /frontend/dist /app/frontend/dist

# NOTE: psycopg2-binary bundles libpq + its transitive deps (libldap, libsasl2,
# libkrb5, etc.) statically inside the wheel itself. The earlier approach of
# copying system .so files from the builder was both unnecessary AND broken on
# Debian 13 trixie (which ships libldap 2.6 instead of 2.5). Distroless ships
# libssl + libz which is all psycopg2-binary needs beyond its own bundle.

WORKDIR /app
EXPOSE 8080

ENTRYPOINT ["python", "-m", "gunicorn", \
            "--bind", "0.0.0.0:8080", \
            "--workers", "4", \
            "--worker-class", "uvicorn.workers.UvicornWorker", \
            "--timeout", "60", \
            "--graceful-timeout", "30", \
            "--access-logfile", "-", \
            "--error-logfile", "-", \
            "main:app"]
