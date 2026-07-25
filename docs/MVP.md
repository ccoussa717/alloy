# Alloy MVP Contract

**Status:** Implemented in the v0.8.2 pre-release source. This document is the product contract,
not a backlog of unfinished ideas.

## In (implemented)

1. **Subscriptions** — Anthropic Claude, OpenAI Codex/ChatGPT, xAI Grok via Pi `/login`. API keys authenticate matching API routes; `OPENAI_API_KEY` is for `openai/...`, not `openai-codex/...`. `/doctor` reports status without printing secrets.
2. **Durable memory** — User + project facts survive `/new` and new processes (`/remember`, `/memory`).
3. **Skills** — Create, compose (skills using skills), capture → approve → promote (`/skill-capture`, `/skill-promote`).
4. **MCP** — Config + live **stdio**, **HTTP (streamable)**, and **SSE** bridges (`/mcp connect`); tools share the central capability gate. Headers support `${ENV}` expansion.
5. **Modes** — `chat` · `plan` · `build` · `review` with hard read-only on plan/review.
6. **Git checkpoints** — `/checkpoint`, `/checkpoints`, `/undo` with authenticated metadata, untracked capture, no `git clean` on restore.
7. **Worktrees** — Isolated builder trees under `~/.pi/alloy/worktrees/` with dirty-baseline seeding.
8. **Diagnostics** — `/diagnose` + `alloy_diagnostics` (typecheck/lint/test when present).
9. **Auto** — `/auto` multi-role pipeline (scout → plan → checkpoint → build → diagnostics → review) with **fix loops** on review FAIL / bad diagnostics.
10. **Fusion** — `/fusion <objective>` runs read-only Architect and Builder proposals concurrently, then one attributed Synthesizer call. `/fusion setup` and `/fusion status` manage each role's model and reasoning effort.
11. **Sub-agents** — `/agent`, `/agents`, profiles, live agent panel.
12. **Docker sandbox** — `/permissions sandbox` routes bash through a session container (`node:22-bookworm`, network none by default). Fail closed if Docker is missing.
13. **Mode and permissions UX** — Shift+Tab cycles Build / Plan; `/permissions` controls approval profiles; `/effort` controls thinking levels.
14. **Help** — `/help`, `/help <topic>`, `/help search <query>`, and `/help commands` for the complete active command registry.
15. **Honesty policy** — Mandatory no-fabrication policy; `/whoami` for harness identity.
16. **Child isolation** — Scrubbed env, policy ceiling, credential boundary, process-group kill (see `docs/SECURITY.md`).
17. **Base harness** — Pi TUI, tools, sessions, tree, compact, `@files`, AGENTS.md, model switch.

## Out (deferred)

- Native descriptor-relative `openat` checkpoint helper (TOCTOU hardening beyond current fail-closed revalidation).
- Micro-VM sandbox product (beyond Docker).
- Provider marketplace / every OpenRouter model as first-class surface.
- GUI / hosted control plane.
- Fix-loop polish and richer multi-model fusion productization beyond current `/auto` + `/fusion`.

## Exit tests (operator machine)

Operator adoption: see **[OPERATIONS.md](./OPERATIONS.md)** and
**[BOUNDARY.md](./BOUNDARY.md)**.

- [ ] `/login` works for Claude, Codex, and Grok (or honest red/green via `/doctor`)
- [ ] Real repo work with tools under `ask-dangerous` (default)
- [ ] `/remember` fact visible after `/new` / new process
- [ ] `/skill-capture` → `/skill-promote` installs a skill
- [ ] `/mcp connect` registers tools from an enabled server
- [ ] `/mode plan` blocks write/edit/bash
- [ ] `/checkpoint` + `/undo` round-trip on a dirty file (including untracked)
- [ ] `/permissions sandbox` + `/sandbox status` with Docker present; fails closed without
- [ ] `/auto` small feature request writes run artifacts under `~/.pi/alloy/runs/`
- [ ] `/fusion` records two valid proposals, one attributed synthesis, usage, and truthful status without leaking credentials
- [ ] No secrets in memory files, drafts, doctor output, or child env (see credential audit)

## Verification (CI / local)

```bash
npm run ci:local          # unit + integration + version + pack
npm run test:integration  # fake MCP, isolated startup, Docker e2e (skips if no Docker)
```
