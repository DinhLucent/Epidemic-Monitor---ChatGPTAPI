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
docker compose up --build
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

The default `docker compose up` path starts both `web` and `worker` so the
refresh loop continues without needing to open the browser first. Use
`docker compose up web` only when you intentionally want read-only UI/API.

The Docker worker is supervised outside the Node process. Each refresh cycle
runs as a separate `node scripts/chatgpt-refresh-worker.mjs --sync-d1 --d1-local`
process, then the supervisor sleeps for `OUTBREAK_REFRESH_INTERVAL_MS` before
starting the next cycle. This prevents a leaked handle or stuck SDK session from
leaving the container alive but idle forever. The cycle is killed after
`CHATGPT_REFRESH_SUPERVISOR_TIMEOUT_MS` when set, or 9 minutes by default.

Before AI classification/extraction starts, the worker probes `CHATGPT2API_BASE_URL`.
If the service is offline, AI jobs remain pending, the pipeline records
`base-url-wait`, telemetry is published, and the next supervised cycle tries
again. Tuning knobs:

- `CHATGPT2API_BASE_URL_WAIT_MS` defaults to 300000.
- `CHATGPT2API_BASE_URL_PROBE_TIMEOUT_MS` defaults to 7000.
- `CHATGPT2API_BASE_URL_RETRY_DELAY_MS` defaults to 15000.
- `CHATGPT2API_BASE_URL_MAX_RETRY_DELAY_MS` defaults to 60000.

The queue claims higher-priority items first, then newer articles by
`published_at`. Docker defaults to `CHATGPT_REFRESH_CLASSIFY_JOB_LIMIT=60` so
fresh articles are classified sooner while the old backlog drains.

## Production worker host

Cloudflare Pages should serve the app in production. The Docker image is most
useful as a long-running production ingestion worker.

One-shot production sync:

```powershell
docker run --rm --env-file .env.local epidemic-monitor:local npm run refresh:chatgpt:prod
```

Supervised production worker:

```powershell
docker run -d --name epidemic-monitor-worker --restart unless-stopped `
  --env-file .env.local `
  -v epidemic-monitor-data:/data `
  epidemic-monitor:local `
  sh scripts/docker-refresh-supervisor.sh --sync-d1 --d1-remote
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
