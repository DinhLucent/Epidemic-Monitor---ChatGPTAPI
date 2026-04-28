# Free-Session Ingestion Evaluation

## Goal

Evaluate how the project could experiment with free-session ChatGPT usage to
collect disease information frequently without changing the existing product
architecture.

## Architecture Rule

Any free-session experiment must stay outside the production runtime.
The safe insertion point is:

```text
free-session ingestion adapter
-> normalize to existing outbreak/news contract
-> push into D1
-> existing Edge APIs and frontend stay unchanged
```

## Candidate Options

### Option 1: Browser automation adapter before D1

Use a separate external worker that:

- logs into the web UI
- asks for structured extraction or summarization
- parses the result
- writes normalized records into D1 through the existing ingestion path

Pros:

- preserves current frontend and API contract
- easiest place to keep failures isolated

Risks:

- session expiry
- CAPTCHA or anti-bot defenses
- policy and ToS risk
- unstable output shape

### Option 2: Free-model adapter instead of free-session web UI

Use free API-accessible models or local models as a replacement for some
pipeline extraction steps, still before D1.

Pros:

- easier to automate and retry
- less brittle than browser sessions

Risks:

- quality may be lower than the current setup
- throughput and quota may fluctuate

### Option 3: Human-in-the-loop triage

Use a lightweight semi-manual review step where a person validates or enriches
 candidate items before they are written to D1.

Pros:

- lowest automation risk
- highest control over quality

Risks:

- slower cadence
- harder to scale

## Recommendation

Treat free-session usage as an experimental external ingestion adapter only.

Recommended order:

1. prototype outside runtime
2. normalize into the same D1 contract already consumed by `functions/_shared/outbreak-query.ts`
3. store provenance and raw prompts/results for auditing
4. keep frontend, Pages Functions, and SHIELD unchanged

## Explicit Anti-Pattern

Do not:

- call free-session logic directly from the frontend
- make Pages Functions depend on live browser sessions
- put ingestion automation inside `Agents-of-SHIELD/`

That would mix development tooling, unstable session behavior, and production
runtime responsibilities in the same path.
