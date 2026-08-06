ARG NODE_BASE_IMAGE=m.daocloud.io/docker.io/library/node:22.17.1-bookworm-slim
ARG PYTHON_BASE_IMAGE=m.daocloud.io/docker.io/library/python:3.12.12-slim-bookworm

FROM ${NODE_BASE_IMAGE} AS frontend-builder
WORKDIR /build
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM ${PYTHON_BASE_IMAGE} AS python-builder
WORKDIR /build
ENV PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY pyproject.toml ./
COPY backend ./backend
RUN python -m pip wheel --no-cache-dir --wheel-dir /wheels ".[ocr,pdf]" \
    && rm -f /wheels/opencv_python-*.whl \
    && python -m pip wheel --no-cache-dir --wheel-dir /wheels --no-deps \
        opencv-python-headless==4.11.0.86

FROM ${PYTHON_BASE_IMAGE} AS runtime
ARG APP_VERSION=0.2.7

RUN sed -ri \
        -e 's|https?://deb.debian.org/debian-security|https://mirrors.ustc.edu.cn/debian-security|g' \
        -e 's|https?://deb.debian.org/debian|https://mirrors.ustc.edu.cn/debian|g' \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=20 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=20 \
        install --yes --no-install-recommends --only-upgrade \
        libgnutls30 \
        libssl3 \
        openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 autovoucher \
    && useradd --uid 10001 --gid autovoucher --create-home --shell /usr/sbin/nologin autovoucher

WORKDIR /app
COPY --from=python-builder /wheels /wheels
RUN python -m pip install --no-cache-dir --no-deps /wheels/*.whl \
    && rm -rf /wheels

COPY --from=frontend-builder /build/dist /app/dist
COPY packaging/ocr_worker.py packaging/pdf_worker.py /app/packaging/

RUN mkdir -p /data \
    && chown -R autovoucher:autovoucher /data /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AUTO_VOUCHER_CONTAINER=1 \
    AUTO_VOUCHER_CORE_VERSION=${APP_VERSION}-docker \
    AUTO_VOUCHER_DATA_DIR=/data \
    AUTO_VOUCHER_STATIC_DIR=/app/dist \
    AUTO_VOUCHER_OCR_WORKER=/app/packaging/ocr_worker.py \
    AUTO_VOUCHER_PDF_WORKER=/app/packaging/pdf_worker.py

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD ["python", "-c", "import json, urllib.request; result=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=3)); raise SystemExit(0 if result.get('ok') and result.get('databaseStatus') == 'ok' and result.get('staticAssets') else 1)"]

CMD ["python", "-m", "auto_voucher", "--host", "0.0.0.0", "--port", "8765", "--data-dir", "/data", "--no-browser"]
