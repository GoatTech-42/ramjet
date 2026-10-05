# ramjet2: core + addons + built web UI + the local search backend, one image.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY core ./core
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip git ffmpeg libheif-examples ca-certificates curl build-essential python3-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./
COPY core ./core
COPY scripts ./scripts
COPY models ./models
COPY bin ./bin
COPY searxng/settings.yml searxng/setup.sh ./searxng/
RUN sh searxng/setup.sh && apt-get purge -y build-essential python3-dev && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /app/searxng/src/.git
COPY searxng/engines/ ./searxng/src/searx/engines/
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data /app/searxng
USER 1000:1000
ENV RJ_HOST=0.0.0.0 RJ_PORT=14224 RJ_DATA=/app/data
EXPOSE 14224
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD curl -fsS -o /dev/null http://127.0.0.1:14224/login || exit 1
CMD ["node", "core/index.js"]
