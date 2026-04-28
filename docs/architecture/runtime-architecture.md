# Runtime Architecture

## Scope

This document describes the production runtime for Epidemic Monitor.
`Agents-of-SHIELD/` is intentionally out of scope for this diagram because it
supports development workflow, not user-facing runtime behavior.

## Functional Blocks

| Block | Responsibility | Main files |
| --- | --- | --- |
| External ingestion pipeline | Crawl, extract, normalize, and push outbreak/news data into D1 on a schedule outside this repo | See runtime note in `README.md` |
| Edge API layer | Read D1 or external weather API, normalize response payloads, and protect runtime endpoints | `functions/_middleware.ts`, `functions/api/health/v1/*` |
| Shared data mapping | Convert D1 hotspot rows into stable `DiseaseOutbreakItem` contracts | `functions/_shared/outbreak-query.ts` |
| Client service layer | Fetch bulk data, cache responses, and persist local snapshots | `src/services/*` |
| App orchestrator | Bootstrap layout, fetch data, wire events, schedule refreshes, connect services to UI | `src/app/app-init.ts`, `src/app/app-context.ts` |
| UI and map presentation | Render panels, map, overlays, and interactive views | `src/components/*` |

## Main Entrypoints

- Browser entrypoint: `src/main.ts`
- App bootstrap: `src/app/app-init.ts`
- Edge middleware: `functions/_middleware.ts`
- Bulk data API: `functions/api/health/v1/all.ts`
## Data Flow

```text
External crawl/extract pipeline
-> Cloudflare D1
-> functions/_shared/outbreak-query.ts
-> /api/health/v1/all
-> src/services/bulk-data-service.ts
-> src/app/app-init.ts
-> ctx + panels + map layers
-> end user
```

Additional flow:

```text
Open-Meteo
-> functions/api/health/v1/climate.ts
-> src/services/climate-service.ts
-> climate panel + early warning map layer
```

## Control Flow

The control center of the runtime is `src/app/app-init.ts`.
It performs the following sequence:

1. build DOM layout
2. mount `MapShell`
3. create panels
4. fetch bulk data
5. push data into context and UI blocks
6. wire event bus interactions
7. start refresh timers and local snapshot tracking
8. initialize optional climate and local trend features

## State and Coordination

- Global runtime state lives in `ctx` inside `src/app/app-context.ts`
- Cross-component coordination uses the lightweight `on()` / `emit()` event bus in the same file
- Historical trend state is stored locally in IndexedDB via `src/services/snapshot-store.ts`
- Map layer render state is held inside `src/components/map-layers/index.ts`

## Core Kernel

The runtime has two practical kernels:

- Data kernel: `functions/_shared/outbreak-query.ts`
  - this is the canonical translation layer from D1 rows to the frontend contract
- App kernel: `src/app/app-init.ts`
  - this is the runtime orchestrator that connects services, state, timers, and UI

## ChatGPT-First Refresh

The preferred ingestion model is background-first: ChatGPT runs in a scheduled
worker, writes validated records/snapshots, and the frontend reads those
snapshots without waiting for model calls. See
`docs/architecture/chatgpt-first-refresh-workflow.md` for the recommended
scheduler, lane concurrency, verification, and dedupe workflow.

## Glue Code

The following modules are mostly glue:

- `src/main.ts`
- `src/app/app-layout.ts`
- `src/services/api-client.ts`
- `src/services/fetch-cache.ts`
- `functions/_middleware.ts`
- `functions/_shared/cache.ts`
- `functions/_shared/cors.ts`
- `dev-api-middleware.ts`

## Explicit Non-Goal

`Agents-of-SHIELD/` does not sit on the production data path.
It should remain a development support layer for planning, review, verification,
and architecture work.
