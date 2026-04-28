# Project Context

## Baseline Snapshot

Checked on 2026-04-12 in the current workspace.

- `npm run build`: passes
  - Vite reports a large client bundle (`dist/assets/index-*.js` about 1.75 MB)
  - Vite also warns about `@loaders.gl/worker-utils` importing `spawn` from a browser-external module
- `npm run typecheck`: passes
- `npm run lint`: passes with non-blocking findings
  - style note in `src/app/app-init.ts` about string concatenation vs template literal
- `npm run test:e2e`: not runnable yet in this environment because Playwright browser binaries are missing

## 1. What The App Does

Epidemic Monitor is a Vietnam-focused public health monitoring web app.
It aggregates outbreak-related signals from Vietnamese news coverage, shows them on a map, and highlights risk levels from the current dataset.

Important product framing:

- it is a reference tool, not an official government source
- the frontend is user-facing, but the ingestion pipeline runs outside this repo
- the UI is built around a map plus dashboard panels rather than a document/report workflow

## 2. Stack And Runtime Boundary

Client/runtime stack:

- Vite + TypeScript
- vanilla DOM app structure, not React
- MapLibre GL + deck.gl for map rendering and overlays
- browser-side caching plus IndexedDB snapshots for short-term history
- no end-user chat runtime; AI is reserved for the external ingestion pipeline

Edge/backend stack:

- Cloudflare Pages Functions
- Cloudflare D1 for persisted outbreak/news data
- Open-Meteo for climate forecast input

Out of runtime scope:

- the ingestion crawler/extraction pipeline described in `README.md`
- `Agents-of-SHIELD/`, which is present in the repo but not part of the production data path

## 3. Main Entrypoints

The repo has a small set of true runtime entrypoints:

- browser boot: `src/main.ts`
- client orchestration: `src/app/app-init.ts`
- layout shell creation: `src/app/app-layout.ts`
- edge middleware: `functions/_middleware.ts`
- bulk data endpoint: `functions/api/health/v1/all.ts`
If someone needs to understand behavior quickly, `src/app/app-init.ts` and `functions/_shared/outbreak-query.ts` are the two highest-value files to read first.

## 4. Data Flow

Primary outbreak/news flow:

```text
external ingestion pipeline
-> D1 tables
-> functions/_shared/outbreak-query.ts
-> functions/api/health/v1/all.ts
-> src/services/bulk-data-service.ts
-> src/app/app-init.ts
-> panels + map layers + banner
```

Climate flow:

```text
Open-Meteo
-> functions/api/health/v1/climate.ts
-> src/services/climate-service.ts
-> climate panel + early warning markers
```

Local history flow:

```text
fresh outbreak data
-> src/services/snapshot-store.ts
-> IndexedDB snapshots
-> src/services/trend-calculator.ts
-> escalation and early warning signals
```

## 5. Core Modules

These modules look like the practical core of the system:

- `functions/_shared/outbreak-query.ts`
  - canonical translation layer from D1 rows into the frontend outbreak contract
  - also contains location resolution and alert-level capping logic
- `functions/api/health/v1/all.ts`
  - main edge aggregation endpoint for outbreaks, stats, and news
- `src/app/app-init.ts`
  - client-side runtime orchestrator for layout, fetching, refresh, event wiring, map sync, and snapshot setup
- `src/services/*`
  - service layer for data fetch, caching, local snapshots, and trend detection
- `src/components/map-layers/index.ts`
  - deck.gl layer coordination point for markers, heatmap, choropleth, districts, and early warnings
- `src/app/app-context.ts`
  - lightweight shared runtime state plus event bus used across the app

## 6. Top 3 Current Pain Points

### 1. Too much orchestration lives in `src/app/app-init.ts`

This file owns layout creation, data loading, refresh timers, timeline logic, event wiring, map behavior, climate integration, and snapshot setup.
It is the fastest place to understand the app, but also the riskiest place to modify because many concerns are coupled together.

### 2. Data freshness and failure behavior are hard to reason about

The runtime mixes several layers:

- an external ingestion pipeline outside the repo
- D1 as the canonical store
- in-memory edge caching in Pages Functions
- client-side cached fetches
- browser-side IndexedDB snapshots
- several silent fallbacks to empty arrays when API calls fail

That makes the user experience resilient, but it also makes stale-data bugs and backend failures harder to spot quickly.

### 3. Frontend performance is likely to become a bottleneck

The current production build emits a large main JS bundle and Vite already warns about chunk size.
Because the app combines deck.gl, MapLibre, multiple panels, and timers in one client bundle, map responsiveness and initial load time are likely to become a meaningful optimization target before larger feature expansion.

## Suggested First Improvement Directions

If the goal is low-risk validation work, the most practical first tasks appear to be:

1. tighten one panel's loading/error/empty state so silent backend failures are easier to see
2. extract one slice of `src/app/app-init.ts` into a dedicated coordinator module
3. add targeted tests around data normalization or local trend detection (`outbreak-query`, `snapshot-store`, or `trend-calculator`)
