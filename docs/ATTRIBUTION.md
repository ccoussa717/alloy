# Attribution and Alloy vs Pi

## Upstream: Pi

Alloy is a **product layer** on [Pi](https://pi.dev), specifically the npm package:

| Field | Value |
|---|---|
| Package | `@earendil-works/pi-coding-agent` |
| Version (pinned range) | `^0.80.10` (resolved 0.80.10 at last audit) |
| License | **MIT** |
| Copyright | Copyright (c) 2025 Mario Zechner |
| Upstream | https://github.com/earendil-works/pi (package directory `packages/coding-agent`) |

Pi’s MIT license text (upstream):

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Alloy **redistributes Pi only as an npm dependency** (not vendored source in this repository). Downstream redistributors of Alloy must preserve Pi’s MIT notice when distributing the combined work (typically via `node_modules` / lockfile and this file).

## This repository: Alloy

| Field | Value |
|---|---|
| Package | `@kylaira/alloy` |
| Copyright | Copyright (c) 2026 Kylaira / Chris Coussa |
| License (current tree) | MIT (`LICENSE`) |
| Strategy note | Public launch discussion recommended **Apache-2.0** for Alloy originals while keeping Pi MIT — **not applied yet** |

## What Alloy owns (divergence from bare Pi)

Alloy does **not** fork or patch Pi’s published sources in-tree. Divergence is **additive**:

| Alloy surface | Role |
|---|---|
| `bin/alloy.mjs`, `install.sh`, `scripts/` | Launcher, Pi discovery, PATH install |
| `extensions/*` | Product commands, policy, MCP bridge, modes, auto, agents, sandbox, honesty, UI |
| `lib/*` | Config trust boundary, capabilities, child runner, checkpoints, worktrees, memory, MCP client, docker sandbox |
| `skills/`, `prompts/`, `themes/`, `agents/` | Starter skills, mode prompts, theme, role prompts |
| `docs/*` | Product + security documentation |
| `test/*` | Alloy unit/integration tests |

## What Pi still owns at runtime

- Interactive TUI and session trees  
- Model registry and `/login` / OAuth/subscription flows  
- Native tools (`read`, `bash`, …) and extension lifecycle  
- Context compaction, `@files`, base agent loop  

## “Isn’t this just Pi with branding?”

**No.** Bare Pi is a single-agent coding runtime. Alloy adds:

- Durable cross-session memory and skill promote workflow  
- Live MCP bridge under the same policy gate  
- Modes, permissions UX, honesty policy  
- Checkpoints / worktrees with adversarial restore rules  
- Multi-agent `/auto`, `/fusion`, `/agent` with **mechanical** child policy and credential boundaries  
- Optional Docker sandbox with honest isolation claims  

Differentiation must stay **demonstrable in code and docs** (this file + `docs/SECURITY.md` + `/doctor`).

## Audit record

| Date | Action |
|---|---|
| 2026-07-23 | Attribution pass for security-readiness (Grok). Confirmed dependency MIT via package metadata + upstream LICENSE fetch; no in-tree Pi source fork. |
