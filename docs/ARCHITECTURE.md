# Alloy Architecture

Alloy is a **product layer** on [Pi](https://pi.dev)
(`@earendil-works/pi-coding-agent`) with an adapted OpenCode-derived interactive
shell. It does not reimplement provider OAuth, credentials, sessions, tools,
policy, or the agent runtime.

**Product boundary:** Alloy is org-agnostic (no required company mesh / shared brain). See [BOUNDARY.md](./BOUNDARY.md).

```text
alloy (Node launcher, bin/alloy.mjs)
  ├─ interactive TTY (default)
  │    └─ Bun 1.3.14 + Solid 1.9.12 + OpenTUI 0.4.5 (tui/)
  │         └─ strict local JSON-lines RPC over child stdio
  │              └─ Pi RPC child + Alloy extensions
  ├─ print / JSON / explicit RPC
  │    └─ Pi directly + Alloy extensions
  └─ --legacy-pi-ui or ALLOY_LEGACY_PI_UI=1
       └─ Pi's previous interactive renderer (rollback only)

Pi + extensions
  ├─ providers and OAuth       /doctor /providers /login /logout
  ├─ memory and skills         /remember /memory /skill-*
  ├─ policy and modes          capability gate + permissions
  ├─ MCP                       stdio / HTTP / SSE tools
  ├─ recovery                  checkpoints + worktrees
  ├─ orchestration             /agent /fusion /fission /auto
  └─ sandbox and diagnostics   Docker Bash + project checks
```

## Layers

| Layer | Owns |
|---|---|
| **Pi** | Agent loop, model registry, OAuth and credentials, sessions, compaction, tools, policy hooks, extension lifecycle |
| **Solid/OpenTUI frontend** | Transcript, composer, scrolling, selection, responsive layout, local selectors, and extension UI dialogs |
| **Alloy Pi fork** | Backend package plus the prior Pi renderer retained as the documented rollback path |
| **Alloy launcher** | Frontend selection, Bun and Pi discovery, process wiring, version string, package injection |
| **Alloy libs** | Config trust boundary, capabilities, MCP client, checkpoints, worktrees, child runner, sandbox, memory store |
| **Operator state** | `~/.pi/alloy/` (config, memory, mcp, runs, worktrees) and Pi's `~/.pi/agent/` (auth, sessions, skills) |

## Interactive RPC boundary

The frontend does not host Pi or duplicate backend policy. The Node launcher
starts Bun with the frontend source and passes the Pi command, arguments, and
working directory through process environment. Bun then spawns one Pi child in
`--mode rpc` with piped stdio.

The RPC client requires a successful `get_state` readiness response before it
renders. Requests carry IDs; explicitly observational requests may use bounded
timeouts, while mutation requests wait for an authoritative response. Stderr is
bounded and redacted before display. Malformed records and correlated response
schema or command mismatches are fatal; late responses to expired observations
are ignored. Backend loss becomes a fatal UI error. Frontend shutdown sends
`SIGTERM`, then `SIGKILL` after a bounded wait. There is no TCP listener, Unix
socket, remote endpoint, or second credential store.

Pi RPC remains authoritative for prompts, streaming, tools, compaction, model
changes, session persistence, and command execution. The frontend hydrates
state, messages, commands, models, and session statistics, then reduces ordered
Pi events into render state.

## Extension UI bridge

Pi extensions continue to call the existing UI API. RPC events bridge
`select`, `confirm`, `input`, `editor`, `close`, `notify`, `setStatus`, `setWidget`,
`setTitle`, and editor text into Solid/OpenTUI. Dialog answers return as
`extension_ui_response`; cancellation is explicit. This keeps permissions,
Alloy commands, OAuth prompts, and workflow status below the frontend boundary.

Commands that Pi previously implemented only inside its renderer are replaced
with RPC-compatible extensions: `/help`, `/resume`, `/tree`, `/fork`, `/reload`,
`/name`, `/hotkeys`, `/login`, `/login-cancel`, and `/logout`. `/new`, `/clone`,
`/compact`, `/session`, `/export`, `/model`, `/thinking`, and `/sidebar` are
frontend-local controls backed by typed Pi RPC requests or local layout state.
Other recognized Alloy extension commands execute through Pi's prompt command
path. Prompt-template and skill commands expand in Pi before their resulting
prompts are queued with steer behavior during streaming.

OpenTUI `/login` permits OAuth only. Secret/API-key prompts are rejected because
the RPC input bridge is intentionally not an unmasked secret-entry surface. API
keys still work through supported environment and Pi configuration routes.

## Trust boundary

- **Global operator config** (`~/.pi/alloy/config.json`) sets security-sensitive defaults: permission profile, sandbox, auto budgets, role models.
- **Project config** may set non-security preferences (e.g. default mode) but **cannot weaken** operator policy, permission ceiling, or MCP trust.
- Project MCP entries are loaded only when explicitly trusted; untrusted project MCP cannot inject host tools.

## Capability gate

All tool calls (native + MCP) pass through `lib/capabilities.mjs`:

- **plan / review** — hard read-only (no bash, write, edit, or MCP calls).
- **chat / build** — gated by permission profile (ask-all → ask-none) and optional sandbox.
- MCP tools are not allowed by name-heuristic bypass; they use the same policy.

## Child agents and credential boundary

Children (`/auto`, `/fusion`, `/fission`, `/agent`) spawn via `lib/child-runner.mjs`:

| Axis | Behavior |
|---|---|
| **Approval ceiling** | Child cannot exceed parent ask-level; `child-enforcer` extension clamps mechanically |
| **Sandbox** | Orthogonal to approval. Parent sandbox or child request → Docker spawn only; fail closed if Docker missing |
| **Env** | Allowlisted keys only; provider API keys stripped |
| **HOME** | Isolated temp HOME / `PI_CODING_AGENT_DIR`; host `auth.json` is never mounted or copied wholesale |
| **Routed credentials** | Only the selected model provider credential is handed to each child over stdin and registered in runtime memory; the host auth store is never mounted or copied |
| **Credential boundary claim** | `docker-fs` when sandboxed (mount policy); `env-home-isolation` on host (same-uid absolute paths remain a host OS limit — not over-claimed) |
| **Lifecycle** | Process-group kill; stream limits; policy manifest recorded per run |

Fusion is a bounded plan-only coordinator: Architect and Builder children run
concurrently with read-only tools, and a Synthesizer runs only after both output
contracts validate. An eligible successful run performs exactly three model
calls; preflight, proposal, abort, and budget failures stop earlier. Fusion has
no code-writing or automatic validation phase. In RPC mode, the extension sends
a bounded, versioned structured widget snapshot alongside the existing string
lines. Model-output snapshots share a trailing 100 ms update window while tool,
phase, failure, and final transitions publish immediately. The producer and
OpenTUI consumer independently redact common credential assignments, token
signatures, URL userinfo, authorization values, and private-key blocks before
rendering the native live role dashboard; RPC hosts that ignore the enhancement
keep the fallback.

Fission is a separate trusted-repository review coordinator. Pure preflight
rejects untrusted projects, non-repositories, unborn `HEAD`, conflicts, and a
clean tree before creating artifacts; clean state returns `NO_CHANGES`. For a
ready tree, normal bounded Git commands capture exact `HEAD`, status, staged and
unstaged patches, and changed regular files. The accepted source digest is
checked immediately and again before judgment and verdict. The packet itself is
also digest-checked. This detects ordinary drift but not hostile same-UID races
or byte-identical ABA restoration.

Each reviewer and the fresh Judge is admitted against one global
operator-configured exact route with no fallback. The emitted provider plus bare
model must attest to that route. Reviewer children have only read tools, and
their `cwd` and `readRoot` are the frozen packet root rather than the repository
root. Complete serialized assistant payloads are subject to an output limit
before parsing or retention. Capacity reservations and usage settlement belong
to the current process's in-process registry, so Fission is intentionally not a
durable workflow engine.

The exact fail-closed caps are 16 KiB request text, 1 MiB status, 2 MiB combined
staged and unstaged patches, 256 KiB per retained file, 2 MiB aggregate retained
files, 10,000 changed entries, and 256 KiB cumulative serialized
completed-assistant output for each reviewer or Judge. Evidence is rejected,
not truncated, when a cap is crossed.

Host normalization, not reviewer claim wording or submitted severity, produces
the final findings. The Judge must cover every submitted finding with a legal
disposition. Unresolved findings, Judge concerns, drift, malformed output,
route/identity failure, cancellation, unknown cost, or settlement failure all
produce `INCOMPLETE`. A completed run is `FAIL` only for an adjudicated finding
at or above the configured blocking threshold; otherwise its deliberately
narrow `PASS` is `no submitted blocking finding validated.`

## Docker sandbox (session)

- Activated by `/permissions sandbox` (not auto-enabled for `/auto`).
- Default image `node:22-bookworm`, network `none`, memory/CPU caps, `cap-drop ALL`, `no-new-privileges`.
- Project/worktree mounted at `/workspace`; bash/`!shell` containerized. File tools remain host path-scoped on the mount in current design.
- MCP stays host-side in v1 (stdio children + remote HTTP/SSE to configured URLs).

## Checkpoints and worktrees

See the concurrency boundary section below. Checkpoints authenticate metadata
against immutable Git anchors; restore fails closed for unversioned or legacy
records.

## Filesystem concurrency boundary

Checkpoint restore and dirty worktree seeding enumerate Git-visible untracked
entries, preserve symlinks without dereferencing them, retain regular-file mode
bits through `0o7777`, and reject containment escapes, state mismatches,
pre-existing symlink ancestors, and destination collisions they observe.
Checkpoint operations first resolve `git rev-parse --show-toplevel`; Git paths,
payload capture, project identity, metadata storage, restore, listing, and
deletion are repository-root relative even when invoked from a subdirectory.
The caller directory is recorded only as provenance.
Restore snapshots symbolic HEAD identity as well as HEAD object,
tracked/index/worktree state, enumerates the actual checkpoint target's tracked
paths, and rechecks restore-relevant ignored files and directories immediately
before mutation. Direct filesystem checks also catch empty untracked or ignored
directories that Git status does not report. Restore performs an actual
temporary create/write/unlink probe for each untracked destination. Those
checks fail closed for detected changes and capability failures.

Creation rejects any unmerged index entries before claiming a checkpoint ID or
ref. Restore preflight initializes an isolated temporary Git directory whose
detached HEAD is the authenticated checkpoint HEAD and whose object lookup uses
the source repository only as an alternate. Stash, patch, index, and
intent-to-add application are therefore exercised in the same reset context as
the real restore without consulting live HEAD or mutating the live repository.

Checkpoint creation claims its generated store ID before creating a durable
ref. New-format canonical refs point to an immutable anchor commit whose
versioned body identifies the checkpoint, canonical ref, expected HEAD,
restore/stash object, and SHA-256 digest of canonical metadata plus every stored
patch and untracked payload, including type, target, and mode. The anchor keeps
the restore object reachable as its parent. Restore and deletion require exact
root/store metadata agreement, verify the live canonical ref and anchor, and
recompute the payload digest before acting. Deletion then compare-and-swap
deletes the verified ref/object before removing discoverable metadata or stored
recovery data. Canonical checkpoint refs must be direct refs. Validation rejects
symbolic refs, and every create, cleanup, and delete compare-and-swap uses
`git update-ref --no-deref` so a ref race cannot mutate a symref target.

Legacy raw-object and immediately prior unanchored metadata have no independently
trusted marker that authenticates their mutable fields. Restore therefore fails
closed with export/migration guidance for every unversioned record. Deletion of
an unversioned record removes only that record's store and root index; it never
mutates a named Git ref.

Checkpoint restore is destructive and requires a quiescent workspace. The
synchronous APIs serialize cooperative checkpoint operations within one Alloy
process, and restore revalidates repository and checkpoint state immediately
before its first mutation. Alloy does not hold an atomic global filesystem or
Git lock that excludes an external editor, Git process, or second Alloy process
after that validation. Both ordinary and malicious external mutation in the
final window are outside the guarantee. Alloy does not claim globally atomic or
TOCTOU-safe path operations; a native descriptor-relative `openat` helper
remains separate future hardening.

## Rules

- Keep runtime, tools, policy, credentials, sessions, and extensions in Pi.
- Keep the OpenTUI process a renderer and RPC client, not a second backend.
- Use Pi's model runtime for OAuth; never collect API keys through unmasked RPC input.
- Keep the Pi renderer only as an explicit rollback path.
- Never log credential values.
- Self-improve skills: propose → approve → write.
- MCP tools share native policy (live bridge).
- Prefer mechanical enforcement over prompt-only policy.
