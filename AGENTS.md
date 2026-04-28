# AGENTS

This repository uses an embedded SHIELD control plane.

Resolve `SHIELD_ROOT` first:

```text
SHIELD_ROOT=.shield
```

Boot order in this repo:

1. Read `.shield/ONBOARDING.md`.
2. Read `.shield/DASHBOARD.md`.
3. Read `.shield/OPERATING_RULES.md`.
4. Read `.shield/CTO_PRODUCT_WORKFLOW.md` only for Product/CTO leadership work or when scope is unclear.
5. Read `.shield/manifest.yaml`.
6. Read `.shield/ROLE_SKILL_MATRIX.md`.
7. Read the required output template under `.shield/templates/` before writing artifacts.

Workspace rules:

- Product source code lives outside `.shield/`.
- SHIELD engine, dashboard assets, runtime state, reports, handoffs, templates, and role curriculum live under `.shield/`.
- Persist paths in artifacts relative to the project root.
- SHIELD-owned persisted paths must begin with `.shield/`.
- Do not put source-repo absolute paths such as `D:\MyProject\MyAgentSkills\...` into artifacts.

Assigned-task rules:

- Claim exactly one worker task per session unless Product/CTO/Producer explicitly merges the scope.
- Read task contract first, then the latest handoff, then the latest session report.
- If the latest report already marks the task completed, do not redo it without an explicit retry, reopen, or replacement task.
- Distinguish the session lane from the task role key.
  - Example: `lead-programmer-agent` is the session lane.
  - Example: `reviewer` is the task role key.
  - In reports, keep `role` and `owner_role` as the task role key and use `role_gate.session_role` for the session lane.

Useful commands:

```powershell
python .shield/run.py compile
python .shield/run.py tasks-sync
python .shield/run.py dashboard-build
python .shield/run.py dashboard-web --port 8123
python .shield/run.py audit
```

Wrapper equivalents:

```powershell
.\shield.ps1 dashboard-build
.\shield.ps1 dashboard-web --port 8123
```
