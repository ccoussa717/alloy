# `@alloy/pi-teams` — portable Teams Slice 1

Portable, read-only team orchestration for Pi. Slice 1 ships one team,
`builtin/investigate`, and one extension registration that exposes the human
`/team` command and the model-callable `team` tool. It targets the common API
surface of Alloy's pinned Pi fork **0.82.1** and stock Pi **0.84.2** on Node
22.19 or newer.

## Stock Pi setup

For stock Pi 0.84.2, install this standalone Pi package. This repository
currently marks the package private, so install a reviewed local checkout or
packed artifact rather than assuming it is published:

```bash
# User setting: records the absolute package path in ~/.pi/agent/settings.json
pi install /absolute/path/to/alloy/packages/pi-teams

# Or project setting: records it in .pi/settings.json (loaded only after trust)
pi install -l /absolute/path/to/alloy/packages/pi-teams
pi list
pi config
```

Pi package settings may also use a future pinned registry source such as
`npm:@alloy/pi-teams@0.1.0` after an authorized publication. Pi packages execute
extension code with the user's authority: review and pin the artifact before
adding it to settings.

## Alloy setup

Alloy root already registers Teams once through its root extension. When running
Alloy 0.82.1 from this repository or its normal distribution, you
**must not add the standalone package again** to user or project Pi package
settings. There is
no second Teams install step: launch Alloy normally, then use `/team list` or
`/help teams`. If both are configured, Pi may retain both extension instances,
and duplicate command/tool resolution is host-dependent. The module-local
same-API registration guard only deduplicates calls within one loaded package
instance; it does not protect against cross-package extension instances.

The package declares these peer ranges:

- `@earendil-works/pi-coding-agent >=0.82.1 <0.85.0`
- `typebox >=1.1.38 <2`

Compatibility is validated against Alloy **0.82.1** and an isolated installation
of stock Pi **0.84.2**. The stock adapter's documented `StockPiSdk` subset is
`createAgentSession`, `DefaultResourceLoader`, `SettingsManager`,
`SessionManager`, `ModelRuntime`, and `getAgentDir`; it uses no post-0.82.1 API.
The package exports its public core and `createStockPiHost` from
`@alloy/pi-teams`, plus the extension from `@alloy/pi-teams/extension`.

## Team catalog and project trust

Manifests are loaded from three locations, in deterministic namespace order:

1. package built-ins: `src/builtins/*.yaml` → `builtin/<name>`;
2. user catalog: `~/.pi/agent/teams/*.yaml` → `user/<name>` (or the effective
   `PI_CODING_AGENT_DIR`);
3. project catalog: `<cwd>/.pi/teams/*.yaml` → `project/<name>`.

Project trust is a hard gate. Project manifests are not opened unless the host
affirmatively reports the current project trusted. Always use a qualified name
when provenance matters. An unqualified name resolves only when it is unique
across all namespaces; ambiguity and collisions within one source fail closed. Symlinks, escaped realpaths,
non-regular files, malformed UTF-8/YAML, and path races are rejected.

Only `builtin/investigate` is active in Slice 1. Its three-member DAG runs two
readers and then a lead synthesis. Manifests cannot select provider model IDs,
define authorization, or add commands.

## Command and tool surfaces

The human command has seven forms:

```text
/team list
/team inspect <team>
/team run <team> <objective>
/team status [run-id]
/team view <run-id> [member-id]
/team approve <run-id>
/team cancel <run-id>
```

`/team run` creates a bounded request, presents its effective admissions and
approval binding, and asks for human approval in an interactive UI. A
noninteractive command stops without execution. `/team approve` is the only
separate approval path and also requires interactive human confirmation.

The team tool (`team`) is a different, model-callable interface with actions
`list`, `inspect`, `request`, `run`, `status`, `view`, and `cancel`. Tool `request` and
`run` are equivalent: they can create an awaiting request but return
`approval_required` and cannot approve or execute it. A human must use
`/team approve <run-id>`. Tool cancellation does not confer approval authority.

## Authority and execution

Slice 1 permits only capability `repo.read` and only the confined tools `read`,
`grep`, `find`, and `ls`. Paths are descriptor-confined to the canonical project
root. The package disables child extensions, skills, prompt templates, themes,
context files, default tools, and model-network catalog refresh.

All members must pass preflight before any provider call. Approval binds the
manifest, compiled plan, public admissions, effective limits, and effective
member timeouts. A host may only narrow authority. Successful admissions expose
a positive `timeoutMs` no greater than the request, and any timeout change
changes the policy digest and requires new approval.

For stock Pi, every member uses the parent's active model and resolved parent
auth in a new isolated in-memory `ModelRuntime`; the adapter never searches for
a fallback route. `StockPiHostOptions.maxTimeoutMs` is an optional operator
ceiling. It is validated as an integer from 1 through 300,000 before SDK or model
use, and admission applies exactly `min(requested timeoutMs, maxTimeoutMs)`—it
never widens a shorter request.

Alloy reuses its existing agent launch, registry, auth, policy, budget,
concurrency, abort, and containment primitives. It clamps each member to the
same four read-only tools and does not create a second execution stack.

Fixed package ceilings include: 65,536 manifest bytes; 512 YAML nodes; depth 12;
zero aliases; 32 files and 1,048,576 bytes per catalog source; 5 members;
concurrency 3; USD 2.00; 300,000 ms; 16,384 objective bytes; 8,192 instruction
bytes; and 1,048,576 output bytes per member. Hosts may narrow these values.

## Approval, cancellation, and containment

Execution requires a matching human approval; a model seeing
`approval_required` has no way to grant it. Failure, timeout, host abort, or
cancellation latches a stop, sends abort before containment to every running
member, starts containment without serial waits, then settles durable events.
Containment and result settlement are independently bounded to **5,000 ms**.
This is bounded abort-before-containment behavior, not proof that an external
provider stopped instantly.

Containment rejection, containment timeout, or result-settlement timeout fails
closed as `run.failed`; it is never presented as successfully cancelled or
contained. A terminal failure can therefore preserve running-member evidence to
show that containment was not proven.

## Events, artifacts, and crash state

The default standalone root is:

```text
~/.pi/agent/team-runs/<sha256-canonical-cwd>/<run-id>/
  manifest.snapshot.json
  request.json
  events.jsonl
  artifacts/<member-id>/output.md
  artifacts/<member-id>/result.json
```

Directories are mode `0700`; files are mode `0600`. `events.jsonl` is the status
authority: append-only, single-writer, contiguous, canonical JSON with a SHA-256
hash chain and fsync boundaries. Member artifacts are digest-addressed and
verified with no-follow, descriptor-pinned reads. UI state, callbacks, child
streams, and process state are not authority.

After a process crash, a valid nonterminal history without its original live
writer/member set projects as `incomplete`. Slice 1 does not resume or append to
that run ID; start a new request. `incomplete` is evidence of interrupted work,
not success or containment.

## Explicit Slice 1 exclusions

Slice 1 provides **no repository mutation** and no write/edit/bash member tools.
It does **not resume** interrupted runs. It provides **no candidate create/apply**,
no commit, no push, no publish, and no deploy capability. It adds **no custom graphical TUI**
(only plain text command/help output) and performs **no Auto/Fusion/Fission/Forge refactor**. It also does not add later built-ins,
manifest-defined model IDs, arbitrary templates, or manifest-defined authority.
