# doc-review (ReWork Check) — Hengelo-portable container.
# Model config via env (MODEL_MODE/MODEL_ID/MODEL_BASE_URL/MODEL_API_KEY) or the
# settings UI (settings.json). Runs + uploads persisted in volumes.
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && mkdir -p runs uploads

ENV PORT=3000 \
    MODEL_MODE=faux \
    NODE_ENV=production

EXPOSE 3000
VOLUME ["/app/runs", "/app/uploads"]

CMD ["node", "dist/src/server.js"]
