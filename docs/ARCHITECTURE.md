# Alloy Architecture

Alloy is a **product layer** on [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`). It does **not** fork Pi and does **not** reimplement provider OAuth.

**Product boundary:** Alloy is org-agnostic (no required company mesh / shared brain). See [BOUNDARY.md](./BOUNDARY.md).

```text
alloy (bin/alloy.mjs)
  └─ resolves Pi CLI (repo node_modules → npm root -g → which pi)
       └─ spawns Pi with Alloy package injected
            └─ extensions/index.ts
                 ├── providers   /doctor /providers
                 ├── memory      /remember /memory + inject
                 ├── skills-improve  capture → promote
                 ├── mcp         live stdio / HTTP / SSE bridge
                 ├── policy      capability gate + permissions UX
                 ├── modes       chat|plan|build|review
                 ├── git         checkpoints
                 ├── worktree    isolated trees
                 ├── diagnostics project checks
                 ├── auto        /auto orchestration
                 ├── agents      /agent multi-model children
                 ├── sandbox     Docker session container
                 ├── child-enforcer  mechanical child policy ceiling
                 ├── honesty     no-fabrication policy
                 ├── help        searchable catalog
                 ├── effort      thinking levels
                 └── ui          chrome, panel, splash
```

## Layers

| Layer | Owns |
|---|---|
| **Pi** | TUI, model registry, `/login`, sessions, compaction, native tools, extension lifecycle |
| **Alloy launcher** | PATH install, Pi discovery, version string, package injection |
| **Alloy libs** | Config trust boundary, capabilities, MCP client, checkpoints, worktrees, child runner, sandbox, memory store |
| **Operator state** | `~/.pi/alloy/` (config, memory, mcp, runs, worktrees) and Pi's `~/.pi/agent/` (auth, sessions, skills) |

## Trust boundary (P0.1)

- **Global operator config** (`~/.pi/alloy/config.json`) sets security-sensitive defaults: permission profile, sandbox, auto budgets, role models.
- **Project config** may set non-security preferences (e.g. default mode) but **cannot weaken** operator policy, permission ceiling, or MCP trust.
- Project MCP entries are loaded only when explicitly trusted; untrusted project MCP cannot inject host tools.

## Capability gate (P0.2)

All tool calls (native + MCP) pass through `lib/capabilities.mjs`:

- **plan / review** — hard read-only (no bash, write, edit, or mutating MCP).
- **chat / build** — gated by permission profile (ask-all → ask-none) and optional sandbox.
- MCP tools are not allowed by name-heuristic bypass; they use the same policy.

## Child agents and credential boundary

Children (`/auto`, `/fusion`, `/agent`) spawn via `lib/child-runner.mjs`:

| Axis | Behavior |
|---|---|
| **Approval ceiling** | Child cannot exceed parent ask-level; `child-enforcer` extension clamps mechanically |
| **Sandbox** | Orthogonal to approval. Parent sandbox or child request → Docker spawn only; fail closed if Docker missing |
| **Env** | Allowlisted keys only; provider API keys stripped |
| **HOME** | Isolated temp HOME / `PI_CODING_AGENT_DIR` (host `auth.json` not shared) |
| **Credential boundary claim** | `docker-fs` when sandboxed (mount policy); `env-home-isolation` on host (same-uid absolute paths remain a host OS limit — not over-claimed) |
| **Lifecycle** | Process-group kill; stream limits; policy manifest recorded per run |

## Docker sandbox (session)

- Activated by `/permissions sandbox` (not auto-enabled for `/auto`).
- Default image `node:22-bookworm`, network `none`, memory/CPU caps, `cap-drop ALL`, `no-new-privileges`.
- Project/worktree mounted at `/workspace`; bash/`!shell` containerized. File tools remain host path-scoped on the mount in current design.
- MCP stays host-side in v1 (stdio children + remote HTTP/SSE to configured URLs).

## Checkpoints and worktrees

See the concurrency boundary section below (merged from remediation work). Checkpoints authenticate metadata against immutable Git anchors; restore fails closed for unversioned/legacy records.

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

- Do not fork Pi.
- Do not implement provider OAuth; use Pi `/login`.
- Never log credential values.
- Self-improve skills: propose → approve → write.
- MCP tools share native policy (live bridge).
- Prefer mechanical enforcement over prompt-only policy.
