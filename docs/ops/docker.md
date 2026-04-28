# Docker Runbook

## Why the build context is the parent folder

This repo depends on local packages from `../ChatGPTtoSDK`. Docker must build
with the parent folder as context so those packages are available:

```powershell
docker compose build
```

The compose file already sets:

```yaml
build:
  context: ..
  dockerfile: baocaotintucsuckhoe/Dockerfile
```

Manual equivalent:

```powershell
docker build -f Dockerfile -t epidemic-monitor:local ..
```

## Local full system

Prepare secrets outside git:

```powershell
Copy-Item .env.docker.example .env.local
```

Set `CHATGPT2API_AUTH_KEY` if your ChatGPT2API server requires it. On Docker
Desktop, containers reach the host ChatGPT2API service through:

```text
http://host.docker.internal:8010
```

Run web only:

```powershell
docker compose up --build web
```

Run web plus background ChatGPT queue worker:

```powershell
docker compose --profile worker up --build
```

Open:

```text
http://127.0.0.1:5174
```

Persistent state is stored in the named Docker volume `epidemic-data`:

- `/data/chatgpt-refresh/queue.db`
- `/data/chatgpt-refresh/latest-snapshot.json`
- `/data/chatgpt-to-sdk`
- `/data/wrangler`

## Production worker host

Cloudflare Pages should serve the app in production. The Docker image is most
useful as a long-running production ingestion worker.

One-shot production sync:

```powershell
docker run --rm --env-file .env.local epidemic-monitor:local npm run refresh:chatgpt:prod
```

Looping production worker:

```powershell
docker run -d --name epidemic-monitor-worker --restart unless-stopped `
  --env-file .env.local `
  -v epidemic-monitor-data:/data `
  epidemic-monitor:local `
  npm run refresh:chatgpt:prod:loop
```

Required production env:

```text
CHATGPT2API_BASE_URL
CHATGPT2API_AUTH_KEY or CHATGPT2API_AUTH_KEYS
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Before the first remote run:

```powershell
npm run db:migrate:prod
```
