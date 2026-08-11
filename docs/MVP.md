# Alloy MVP Contract

**Status:** Implemented in the v0.8.4 pre-release source. This document is the product contract,
not a backlog of unfinished ideas.

## In (implemented)

1. **Subscriptions** — Anthropic Claude, OpenAI Codex/ChatGPT, and xAI Grok through Pi OAuth. OpenTUI `/login` is OAuth-only because RPC text input is intentionally not masked. API keys authenticate matching API routes through environment/config; `OPENAI_API_KEY` is for `openai/...`, not `openai-codex/...`. `/doctor` reports status without printing secrets.
2. **Durable memory** — User + project facts survive `/new` and new processes (`/remember`, `/memory`).
3. **Skills** — Create, compose (skills using skills), capture → approve → promote (`/skill-capture`, `/skill-promote`).
4. **MCP** — Config + live **stdio**, **HTTP (streamable)**, and **SSE** bridges (`/mcp connect`); tools share the central capability gate. Headers support `${ENV}` expansion.
5. **Modes** — `chat` · `plan` · `build` · `review` with hard read-only on plan/review.
6. **Git checkpoints** — `/checkpoint`, `/checkpoints`, `/undo` with authenticated metadata, untracked capture, no `git clean` on restore.
7. **Worktrees** — Isolated builder trees under `~/.pi/alloy/worktrees/` with dirty-baseline seeding.
8. **Diagnostics** — `/diagnose` + `alloy_diagnostics` (typecheck/lint/test when present).
9. **Auto** — `/auto` multi-role pipeline (scout → plan → checkpoint → build → diagnostics → review) with **fix loops** on review FAIL / bad diagnostics.
10. **Fusion** — `/fusion <objective>` runs read-only Architect and Builder proposals concurrently, then one attributed Synthesizer call. `/fusion setup` and `/fusion status` manage each role's model and reasoning effort.
11. **Fission** — `/fission [1..5] <request>` and `alloy_fission` run bounded read-only adversarial review through blind specialists and a fresh Judge. **Auto** mode reviews freeform subjects (plans, docs, ideas) anywhere, and freezes a trusted dirty git tree when one is available. **Repo** mode (`--repo`) stays fail-closed for CI dirty-tree gates. Exact global routes have no fallback; `NO_CHANGES` (repo only), `INCOMPLETE`, narrow `PASS`, and blocking `FAIL` are host outcomes.
12. **Sub-agents** — `/agent`, `/agents`, profiles, live agent panel.
13. **Docker sandbox** — `/permissions sandbox` routes bash through a session container (`node:22-bookworm`, network none by default). Fail closed if Docker is missing.
14. **Mode and permissions UX** — Shift+Tab cycles Build / Plan; `/permissions` controls approval profiles; `/effort` controls thinking levels.
15. **Help** — `/help`, `/help <topic>`, `/help search <query>`, and `/help commands` for the complete active OpenTUI and backend command registry.
16. **Honesty policy** — Mandatory no-fabrication policy; `/whoami` for harness identity.
17. **Child isolation** — Scrubbed env, policy ceiling, credential boundary, process-group kill (see `docs/SECURITY.md`).
18. **Interactive shell** — Node launcher to pinned Bun 1.3.14, Solid 1.9.12, and OpenTUI 0.4.5, with Pi as a strict local RPC child.
19. **Extension UI bridge** — Pi extension select, confirm, input, editor, notifications, status, widgets, title, and editor text render in OpenTUI.
20. **Pi backend** — Tools, credentials, policy, sessions, extension lifecycle, compaction, `@files`, AGENTS.md, and model registry remain Pi-owned. Print, JSON, and RPC modes run Pi directly.
21. **Session command compatibility** — OpenTUI local commands cover new, clone, compact, session stats, export, model, thinking, sidebar, and quit. RPC-compatible extensions cover help, resume, tree, fork, reload, name, hotkeys, login, login cancellation, and logout.
22. **Local models** — Ollama, llama.cpp, and LM Studio catalogs are discovered before initial model resolution. Keyless loopback servers require no login; optional endpoint keys stay in environment variables. Pi's native `llama.cpp` provider remains separate from Alloy's `llama.cpp-local` discovery alias.

## Out (deferred)

- Native descriptor-relative `openat` checkpoint helper (TOCTOU hardening beyond current fail-closed revalidation).
- Micro-VM sandbox product (beyond Docker).
- Provider marketplace / every OpenRouter model as first-class surface.
- GUI / hosted control plane.
- Fix-loop polish and richer multi-model fusion productization beyond current `/auto` + `/fusion`.
- OpenCode's server, SDK contract, workspace model, and plugin host.
- Unmasked API-key entry in OpenTUI.
- Full command parity with either OpenCode or the legacy Pi renderer beyond the commands listed above.
- `/auto` integration for Fission. It remains follow-up work until the manual authenticated dogfood gate passes.

## Exit tests (operator machine)

Operator adoption: see **[OPERATIONS.md](./OPERATIONS.md)** and
**[BOUNDARY.md](./BOUNDARY.md)**.

- [ ] OpenTUI `/login` completes Pi OAuth for available Claude, Codex, and Grok routes (or reports honest red/green via `/doctor`)
- [ ] Real repo work with tools under `ask-dangerous` (default)
- [ ] `/remember` fact visible after `/new` / new process
- [ ] `/skill-capture` → `/skill-promote` installs a skill
- [ ] `/mcp connect` registers tools from an enabled server
- [ ] `/mode plan` blocks write/edit/bash
- [ ] `/checkpoint` + `/undo` round-trip on a dirty file (including untracked)
- [ ] `/permissions sandbox` + `/sandbox status` with Docker present; fails closed without
- [ ] `/auto` small feature request writes run artifacts under `~/.pi/alloy/runs/`
- [ ] `/fusion` records two valid proposals, one attributed synthesis, usage, and truthful status without leaking credentials
- [ ] Offline dogfood materialization creates nine dirty repositories without model access
- [ ] Nine manual authenticated `/fission 5` runs validate all six seeded blockers and keep all three controls free of blocking findings
- [ ] OpenTUI hydrates Pi history, streams output, renders extension dialogs, restores the terminal, and exits nonzero on backend loss
- [ ] `alloy -p`, JSON mode, and RPC mode bypass OpenTUI; `--legacy-pi-ui` selects the rollback renderer
- [ ] `alloy --list-models` includes models from available Ollama, llama.cpp, and LM Studio test servers before session start
- [ ] No secrets in memory files, drafts, doctor output, or child env (see credential audit)

## Verification (CI / local)

```bash
npm run ci:local          # unit + integration + version + pack
npm run test:integration  # fake MCP, isolated startup, Docker e2e (skips if no Docker)
```
