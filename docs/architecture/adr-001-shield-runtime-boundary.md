# ADR-001: Keep Agents-of-SHIELD Outside Product Runtime

- Status: Accepted
- Date: 2026-04-12

## Context

The repository contains two different systems:

- the Epidemic Monitor product runtime
- the `Agents-of-SHIELD/` development control plane

The product runtime serves users through `src/`, `functions/`, D1, and an
external ingestion pipeline. `Agents-of-SHIELD/` is a local orchestrator that
classifies work, builds task packets, routes roles, verifies outputs, and
stores handoffs for development workflow.

The project also wants room to experiment with low-cost or free-session based
information gathering in the future.

## Decision

`Agents-of-SHIELD/` will remain outside the product runtime boundary.

It is allowed to support:

- architecture mapping
- ADR and design review workflows
- task planning and routing
- verification and handoff during development
- impact analysis before runtime changes

It must not become:

- the ingestion scheduler for production data
- the runtime orchestrator behind the user-facing app
- the API path for end-user data retrieval
- the place where free-session ChatGPT automation is embedded for production use

## Consequences

- The production runtime remains stable and easier to reason about.
- Architecture experiments can happen without coupling the app to SHIELD internals.
- Any future free-session ingestion experiment must be treated as an external
  adapter before D1, not as a frontend or SHIELD runtime concern.
- SHIELD tasks that target the parent project should reference sibling files
  explicitly using paths like `../src/...` and `../functions/...`.

## Follow-Up

- Keep canonical runtime architecture docs under `docs/architecture/`
- Use SHIELD task packs to maintain those docs and evaluate proposed changes
- If SHIELD needs deeper parent-project awareness later, add that deliberately
  as workspace integration rather than silently merging boundaries
