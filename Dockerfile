# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build context is the parent project folder (see docker-compose.yml) because
# package.json uses file:../ChatGPTtoSDK dependencies.
COPY ChatGPTtoSDK /ChatGPTtoSDK
COPY baocaotintucsuckhoe/package.json baocaotintucsuckhoe/package-lock.json ./

RUN cd /ChatGPTtoSDK \
  && npm ci \
  && npm run build -w @chatgpt-to-sdk/core -- --force \
  && npm run build -w @chatgpt-to-sdk/sdk-ts -- --force \
  && npm run build -w @chatgpt-to-sdk/session-sqlite -- --force \
  && npm run build -w @chatgpt-to-sdk/provider-openai-compatible -- --force
RUN npm ci

FROM deps AS build

COPY baocaotintucsuckhoe ./

RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV CHATGPT_REFRESH_QUEUE_DB_PATH=/data/chatgpt-refresh/queue.db
ENV CHATGPT_REFRESH_SNAPSHOT_PATH=/data/chatgpt-refresh/latest-snapshot.json
ENV CHATGPT_REFRESH_STATE_ROOT=/data/chatgpt-to-sdk
ENV CHATGPT_D1_PERSIST_TO=/data/wrangler

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /ChatGPTtoSDK /ChatGPTtoSDK
COPY --from=build /app /app

RUN mkdir -p /data/chatgpt-refresh /data/chatgpt-to-sdk /data/wrangler

VOLUME ["/data"]

EXPOSE 5174

CMD ["npm", "run", "docker:web"]
