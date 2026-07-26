# Attribution and Alloy vs Pi

## Upstream: Pi

Alloy is a **product layer** on [Pi](https://pi.dev), specifically the npm package:

| Field | Value |
|---|---|
| Package | `@earendil-works/pi-coding-agent` |
| Version | `0.82.1` plus Alloy viewport patch |
| License | **MIT** |
| Copyright | Copyright (c) 2025 Mario Zechner |
| Upstream | https://github.com/earendil-works/pi (package directory `packages/coding-agent`) |
| Alloy fork | https://github.com/ccoussa717/pi |
| Runtime artifact | `alloy-tui-v0.82.1.2`, pinned by URL and SHA-512 integrity in `npm-shrinkwrap.json` |

See [PI_FORK.md](./PI_FORK.md) for the source commit, artifact hashes,
dependency-graph decision, upgrade procedure, and rollback procedure.

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

Alloy **redistributes Pi as package dependencies**, with the coding-agent package
coming from an integrity-pinned release asset in the public Alloy fork. Pi source
is not vendored in this repository. Downstream redistributors of Alloy must
preserve Pi's MIT notice when distributing the combined work, including through
`node_modules`, the shrinkwrap, and this file.

## Acknowledgments and inspiration

Alloy also credits two open-source projects that helped shape its product and
presentation:

| Project | Credit |
|---|---|
| [OpenCode](https://github.com/anomalyco/opencode) | Inspiration for a focused terminal-first developer experience and clear open-source product presentation. |
| [Fusion Harness](https://github.com/disler/fusion-harness) | Inspiration for explicit multi-model role framing and presenting independent perspectives as an attributable synthesis. |

These are acknowledgments of inspiration, not Alloy runtime dependencies. Alloy
does not redistribute their source or visual assets. Pi is the runtime foundation
and npm dependency described above.

## This repository: Alloy

| Field | Value |
|---|---|
| Package | `alloy-agent` |
| Copyright | Copyright (c) 2026 Alloy contributors |
| License | MIT (`LICENSE`) |

## What Alloy owns (divergence from bare Pi)

Alloy does **not** vendor or patch Pi sources in-tree. The public fork changes
only interactive viewport behavior, transcript navigation, and standard user
message presentation. The remaining divergence is additive:

| Alloy surface | Role |
|---|---|
| `bin/alloy.mjs`, `install.sh`, `scripts/` | Launcher, Pi discovery, PATH install |
| `extensions/*` | Product commands, policy, MCP bridge, modes, auto, agents, sandbox, honesty, UI |
| `lib/*` | Config trust boundary, capabilities, child runner, checkpoints, worktrees, memory, MCP client, docker sandbox |
| `skills/`, `prompts/`, `themes/` | Starter skills, mode prompts, and theme |
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

Alloy remains **org-agnostic**: no required dependency on any company mesh or knowledge base. See `docs/BOUNDARY.md`.

Dependency versions and integrity are pinned in `npm-shrinkwrap.json`. GitHub
Actions generates a CycloneDX SBOM and verifies package metadata before
publication.
