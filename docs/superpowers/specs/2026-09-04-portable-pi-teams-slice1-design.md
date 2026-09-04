# Portable Pi Teams Slice 1 Design

**Status:** Approved for implementation
**Date:** 2026-09-04
**Scope:** Slice 1 only — portable, read-only `builtin/investigate`

## Goal

Ship Teams as a portable Pi package that runs the same bounded, read-only
`builtin/investigate` role DAG in stock Pi and Alloy. One typed, host-neutral
service owns manifests, policy, durable events, artifacts, scheduling, and run
state. The stock and Alloy integrations adapt existing host execution
mechanisms; commands, the model tool, and presentation are clients of that
service and never become execution authority.

Slice 1 proves portability, trust and policy boundaries, orchestration,
durability, and artifact integrity. It does not prove repository mutation or
recovery.

## Product Boundary

Slice 1 includes exactly:

- strict YAML team manifests;
- package, user, and trusted-project catalogs;
- the namespaced `builtin/investigate` team;
- semantic role compilation and a bounded DAG scheduler;
- read-only stock Pi and Alloy host adapters;
- hash-chained append-only run events and digest-addressed member artifacts;
- one shared `TeamService` used by `/team` and the model-callable `team` tool;
- text presentation through Pi's common extension APIs;
- compatibility with Alloy's Pi fork `0.82.1` and stock Pi `0.84.2`.

The following are explicitly outside Slice 1 and must not be introduced by its
implementation:

- repository or filesystem mutation by team members;
- writer roles, worktree creation, candidate creation, candidate application,
  committing to the caller's branch, push, publication, or deployment;
- resuming or recovering an incomplete run under the same run ID;
- `builtin/review`, `builtin/feature`, or user-visible activation of any other
  built-in team;
- a custom graphical TUI, panel, widget, or sidebar;
- refactoring, wrapping, or changing Auto, Fusion, Fission, or Forge;
- a second Alloy router, credential broker, child runner, budget ledger,
  process-containment layer, or worktree manager;
- general templating, arbitrary commands in manifests, project-selected model
  IDs, or manifest-defined authorization.

## Compatibility And Package Boundary

The portable package lives at `packages/pi-teams/`. Its package manifest exposes
`src/extension/index.ts` through Pi's `pi.extensions` metadata and declares the
Pi coding-agent and TypeBox packages as peers. It directly depends on
`yaml@2.9.0`; YAML must not be consumed as an undeclared transitive dependency.

The common extension layer uses only APIs present in both target runtimes:

- `ExtensionAPI.registerCommand`;
- `ExtensionAPI.registerTool`;
- `ExtensionContext.cwd`, `model`, `modelRegistry`, `isProjectTrusted()`,
  `signal`, `hasUI`, and `ui` text dialogs/notifications;
- `createAgentSession`, `DefaultResourceLoader`, `SettingsManager`,
  `SessionManager.inMemory`, and the read-only built-in tools used by the stock
  adapter.

It does not use APIs introduced after Pi `0.82.1`. Compatibility is established
by a root-package smoke test against Alloy's pinned `0.82.1` dependency and an
installed-package smoke test against stock Pi `0.84.2`.

Alloy includes `packages/pi-teams/` in its package file boundary. Alloy's root
extension imports and invokes `registerTeams` once through `extensions/teams.ts`.
The nested package's `pi.extensions` metadata is for standalone stock Pi
installation only; Alloy does not separately add that entry point to its root
`pi.extensions`. This prevents duplicate `/team` and `team` registration.

## Repository Layout And Responsibilities

```text
packages/pi-teams/
  package.json                    portable Pi package metadata
  README.md                       standalone install, manifest, and command docs
  src/
    index.ts                      public type and factory exports
    core/
      types.ts                    shared domain types and discriminated unions
      limits.ts                   immutable Slice 1 resource ceilings
      manifest.ts                 safe YAML parsing and structural validation
      catalog.ts                  namespaces and deterministic name resolution
      compiler.ts                 normalized plans, digests, and DAG validation
      policy.ts                   capability intersection and approval binding
      events.ts                   canonical event hashing and history validation
      projection.ts               deterministic run/member projection
      scheduler.ts                pure bounded DAG state transitions
      service.ts                  TeamService and injected port orchestration
    storage/
      catalog-loader.ts           bounded built-in/user/project manifest loading
      file-event-store.ts         exclusive append-only per-run writer
      file-artifact-store.ts      secure artifact write/read/verification
    adapters/
      stock-pi.ts                 bounded in-process stock Pi child sessions
    extension/
      index.ts                    standalone factory and single registration
      commands.ts                 `/team` parsing and human approval flow
      tool.ts                     strict `team` tool schema and dispatch
      presentation.ts             plain-text result rendering
    builtins/
      investigate.yaml            only active Slice 1 built-in
extensions/
  teams.ts                        Alloy registration composition
lib/
  teams-host.mjs                  Alloy host adapter over existing primitives
test/unit/
  teams-*.test.mjs               model-free package, core, adapter, and wiring tests
test/integration/
  teams-stock-pi.e2e.test.mjs     packed package smoke against stock Pi 0.84.2
```

`packages/pi-teams/src/core/` imports neither Pi nor Alloy. Pure functions own
normalization, compilation, policy decisions, event validation, projection,
and scheduler transitions. `TeamService` performs effects only through the
injected `TeamHost`, `EventStore`, and `ArtifactStore` ports. Filesystem code is
isolated under `storage/`; runtime-specific child execution is isolated under
`adapters/` and `lib/teams-host.mjs`.

## Domain Interfaces

The authoritative interfaces are:

```ts
export type TeamNamespace = "builtin" | "user" | "project";
export type TeamRef = `${TeamNamespace}/${string}`;
export type TeamRoute = "research" | "review" | "planning";
export type TeamCapability = "repo.read";
export type TeamToolName = "read" | "grep" | "find" | "ls";
export type Actor =
  | { kind: "human"; id: string }
  | { kind: "model"; id: string }
  | { kind: "system"; id: string };

export interface TeamMember {
  id: string;
  route: TeamRoute;
  capabilities: TeamCapability[];
  tools: TeamToolName[];
  needs: string[];
  instructions: string;
}

export interface TeamLimits {
  maxConcurrency: number;
  maxCostUsd: number;
  timeoutMs: number;
  maxMembers: number;
}

export interface TeamDefinition {
  apiVersion: "pi.dev/teams/v1alpha1";
  kind: "Team";
  metadata: { name: string; description: string };
  spec: { limits: TeamLimits; members: TeamMember[] };
}

export interface CompiledTeam {
  ref: TeamRef;
  source: TeamNamespace;
  definition: TeamDefinition;
  topologicalOrder: string[];
  manifestDigest: string;
  planDigest: string;
}

export interface HostCapabilities {
  capabilities: TeamCapability[];
  tools: TeamToolName[];
  maxConcurrency: number;
  supportsCancellation: boolean;
}

export interface TeamRunContext {
  cwd: string;
  projectId: string;
  projectTrusted: boolean;
  source: "command" | "tool";
  signal?: AbortSignal;
  runtime: unknown;
}

export type Admission =
  | {
      ok: true;
      memberId: string;
      effectiveRoute: string;
      effectiveModel: string | null;
      effectiveCapabilities: TeamCapability[];
      effectiveTools: TeamToolName[];
      maxCostUsd: number;
      token: unknown;
    }
  | {
      ok: false;
      memberId: string;
      effectiveRoute: null;
      effectiveModel: null;
      effectiveCapabilities: [];
      effectiveTools: [];
      maxCostUsd: number;
      reason: string;
      token?: never;
    };

export type AdmittedMember = Extract<Admission, { ok: true }>;
export type PublicAdmission = Admission extends infer T
  ? T extends Admission ? Omit<T, "token"> : never
  : never;

export interface MemberPreflightInput {
  member: TeamMember;
  maxCostUsd: number;
  timeoutMs: number;
}

export interface MemberRunInput {
  runId: string;
  objective: string;
  member: TeamMember;
  dependencies: Array<{
    memberId: string;
    artifact: ArtifactRef;
    text: string;
  }>;
  admission: AdmittedMember;
  maxCostUsd: number;
  timeoutMs: number;
}

export interface MemberResult {
  ok: boolean;
  text: string;
  model: string | null;
  usage: { input: number; output: number; costUsd: number | null };
  error?: string;
}

export interface TeamHost {
  readonly id: "stock-pi" | "alloy";
  capabilities(context: TeamRunContext): Promise<HostCapabilities>;
  preflightMember(
    input: MemberPreflightInput,
    context: TeamRunContext,
  ): Promise<Admission>;
  runMember(
    input: MemberRunInput,
    context: TeamRunContext,
    signal: AbortSignal,
  ): Promise<MemberResult>;
  contain?(runId: string): Promise<void>;
}

export interface EventWriter {
  append(draft: EventDraft): Promise<TeamEvent>;
  close(): Promise<void>;
}

export interface EventStore {
  createRun(input: RunSnapshotInput): Promise<EventWriter>;
  read(projectId: string, runId: string): Promise<TeamEvent[]>;
  list(projectId: string): Promise<string[]>;
}

export interface ArtifactRef {
  memberId: string;
  outputPath: string;
  resultPath: string;
  outputBytes: number;
  outputSha256: string;
  resultBytes: number;
  resultSha256: string;
}

export interface ArtifactStore {
  writeMember(
    projectId: string,
    runId: string,
    memberId: string,
    result: MemberResult,
  ): Promise<ArtifactRef>;
  readVerified(projectId: string, runId: string, ref: ArtifactRef): Promise<{
    text: string;
    result: MemberResult;
  }>;
}

export type TeamEventType =
  | "run.requested" | "manifest.snapshotted" | "policy.admitted"
  | "policy.blocked" | "run.awaiting_approval" | "approval.granted"
  | "run.started" | "member.ready" | "member.started"
  | "member.artifact_recorded" | "member.succeeded" | "member.failed"
  | "budget.observed" | "cancel.requested" | "member.cancelled"
  | "run.completed" | "run.failed" | "run.blocked" | "run.cancelled";

export interface EventDraft {
  type: TeamEventType;
  actor: Actor;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface RunSnapshotInput {
  projectId: string;
  runId: string;
  manifest: TeamDefinition;
  request: {
    teamRef: TeamRef;
    objective: string;
    actor: Actor;
    requestedAt: string;
  };
}

export interface TeamSummary {
  ref: TeamRef;
  description: string;
  members: number;
  limits: TeamLimits;
}

export type TeamMemberStatus =
  | "pending" | "ready" | "running" | "succeeded" | "failed" | "cancelled";
export type TeamRunStatus =
  | "awaiting_approval" | "running" | "completed" | "failed"
  | "blocked" | "cancelled" | "incomplete";

export interface TeamMemberView {
  id: string;
  status: TeamMemberStatus;
  artifact?: ArtifactRef;
  error?: string;
}

export interface TeamRunView {
  projectId: string;
  runId: string;
  teamRef: TeamRef;
  objective: string;
  status: TeamRunStatus;
  manifestDigest: string;
  planDigest: string;
  policyDigest?: string;
  approvalBinding?: ApprovalBinding;
  limits: TeamLimits;
  admissions: PublicAdmission[];
  members: Record<string, TeamMemberView>;
  usage: { input: number; output: number; costUsd: number | null };
  lastEvent: TeamEvent;
}

export interface MemberView {
  run: TeamRunView;
  member: TeamMemberView;
  text: string;
  result: MemberResult;
}

export interface ScheduleState {
  team: CompiledTeam;
  cancelling: boolean;
  members: Record<string, { id: string; status: TeamMemberStatus }>;
}
```

`signal` is copied from the common Pi extension context and can only reduce a
run's authority by cancelling work. `runtime` is an opaque adapter-owned value.
Core logic never inspects it, serializes it, hashes it, or grants authority based
on it.

The service surface shared by the command and tool is:

```ts
export interface TeamService {
  list(context: TeamRunContext): Promise<TeamSummary[]>;
  inspect(teamRef: string, context: TeamRunContext): Promise<CompiledTeam>;
  request(input: {
    teamRef: string;
    objective: string;
    actor: Actor;
    context: TeamRunContext;
  }): Promise<TeamRunView>;
  approve(input: {
    runId: string;
    actor: Extract<Actor, { kind: "human" }>;
    binding: ApprovalBinding;
    context: TeamRunContext;
  }): Promise<TeamRunView>;
  execute(runId: string, context: TeamRunContext): Promise<TeamRunView>;
  cancel(runId: string, actor: Actor, context: TeamRunContext): Promise<TeamRunView>;
  status(runId: string | undefined, context: TeamRunContext): Promise<TeamRunView>;
  view(
    runId: string,
    memberId: string | undefined,
    context: TeamRunContext,
  ): Promise<TeamRunView | MemberView>;
}
```

Supporting implementation contracts used by the factories are also fixed:

```ts
export interface CatalogEntry {
  ref: TeamRef;
  source: TeamNamespace;
  origin: string;
  definition: TeamDefinition;
}

export interface TeamCatalog {
  list(): CatalogEntry[];
  resolve(ref: string): CatalogEntry;
}

export interface PolicyIntersectionInput {
  member: TeamMember;
  host: HostCapabilities;
  admission: Admission;
  maxCostUsd: number;
  timeoutMs: number;
}
export type PolicyDecision = Admission;

export interface TeamServiceDependencies {
  catalogFor(context: TeamRunContext): Promise<TeamCatalog>;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  host: TeamHost;
  now(): string;
  randomUUID(): string;
}

export interface FileEventStoreOptions {
  root: string;
  now?: () => string;
  randomUUID?: () => string;
  fs?: typeof import("node:fs/promises");
}

export interface FileArtifactStoreOptions {
  root: string;
  fs?: typeof import("node:fs/promises");
}

export interface StockPiHostOptions {
  sdk?: Pick<
    typeof import("@earendil-works/pi-coding-agent"),
    | "createAgentSession"
    | "DefaultResourceLoader"
    | "SettingsManager"
    | "SessionManager"
  >;
  agentDir?: string;
}
```

The policy helper treats a blocked host admission as blocked. For an admitted
result it verifies that every effective capability/tool is requested by the
member and allowed by package and host bounds, that the route still represents
the member's semantic route, and that cost/timeout do not exceed the supplied
ceilings. Operator policy and the live parent ceiling are enforced inside the
host preflight; the core validates the returned narrowing before recording it.
The effective run limits copy the manifest limits and reduce
`maxConcurrency` to the host ceiling before policy hashing and approval.

## Manifest Format And Security Bounds

Slice 1 accepts this shape:

```yaml
apiVersion: pi.dev/teams/v1alpha1
kind: Team
metadata:
  name: investigate
  description: Parallel repository investigation with lead synthesis
spec:
  limits:
    maxConcurrency: 2
    maxCostUsd: 2
    timeoutMs: 300000
    maxMembers: 3
  members:
    - id: architecture
      route: research
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      instructions: Map the relevant architecture and cite repository evidence.
    - id: risks
      route: review
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      instructions: Identify compatibility, security, and failure-mode risks.
    - id: lead
      route: planning
      capabilities: [repo.read]
      tools: [read, grep, find, ls]
      needs: [architecture, risks]
      instructions: Synthesize the verified member evidence into one answer.
```

The parser enforces all of these fixed limits before compilation or model use:

| Limit | Value |
|---|---:|
| manifest UTF-8 bytes | 65,536 |
| YAML nodes | 512 |
| YAML nesting depth | 12 |
| aliases | 0 |
| documents per file | 1 |
| manifests per catalog source | 32 |
| aggregate bytes per catalog source | 1,048,576 |
| members | 5 |
| concurrency | 3 |
| maximum declared cost | USD 2.00 |
| timeout | 300,000 ms |
| objective UTF-8 bytes | 16,384 |
| description UTF-8 bytes | 1,024 |
| instructions UTF-8 bytes per member | 8,192 |
| member output UTF-8 bytes | 1,048,576 |
| artifact result JSON bytes | 65,536 |

Parsing uses `yaml@2.9.0` in strict document mode. Duplicate mapping keys,
aliases, anchors, merge keys, explicit/custom tags, directives other than the
ordinary YAML version directive, multiple documents, non-string mapping keys,
non-finite numbers, nulls where values are required, and non-plain objects are
rejected. The parser counts AST nodes and depth before converting to data, then
recursively copies accepted mappings into null-prototype plain objects. Unknown
fields are rejected at every schema level.

Identifiers must match `^[a-z][a-z0-9-]{0,63}$`. Arrays must be nonempty where
required and contain no duplicates. Integer limits reject booleans, fractions,
NaN, and infinity. `maxMembers` must equal the actual member count;
`maxConcurrency` cannot exceed it. A manifest may request only `repo.read` and
only `read`, `grep`, `find`, and `ls`. Routes are semantic roles and never model
IDs.

`needs` defaults to `[]`. Dependencies must name another member, may not name
the member itself, and must form an acyclic graph. Dependency artifacts are
passed to downstream members as a structured array; instructions are never
interpreted as shell, code, templates, substitutions, or interpolation.

## Catalog And Trust

Catalog entries always have a namespace:

- package built-ins: `builtin/<name>`;
- operator files in `~/.pi/agent/teams/*.yaml`: `user/<name>`;
- project files in `.pi/teams/*.yaml`: `project/<name>`.

Files are processed in lexical order. Only regular, non-symlink `.yaml` files
whose real path remains beneath the expected catalog root are read. Per-source
file count and aggregate byte limits apply before parsing.

Project files are not statted, opened, or parsed unless the current Pi or Alloy
context returns `isProjectTrusted() === true`. Trust is supplied by the host; a
manifest cannot assert it. Built-ins and user manifests remain available in an
untrusted project.

Fully qualified names resolve exactly. A short name resolves only when exactly
one loaded namespace contains it. Multiple matches return an ambiguity error
listing qualified names. A project or user manifest therefore cannot silently
shadow `builtin/investigate`. Duplicate fully qualified names fail catalog load.
Only `builtin/investigate` ships in Slice 1.

## Compilation And Policy

Compilation is deterministic. It normalizes optional `needs`, sorts dependency
lists for hashing, preserves declared member order for stable presentation,
computes a stable topological order with declaration order as the tie-breaker,
and computes SHA-256 digests over canonical JSON:

- `manifestDigest`: normalized `TeamDefinition`;
- `planDigest`: qualified ref, normalized members, topological order, and
  limits.

The compiler rejects duplicate IDs, unknown dependencies, cycles, unsupported
routes, unsupported capabilities/tools, and all limit violations before any
host preflight.

Effective member authority is the intersection of:

1. Slice 1 package support (`repo.read` and the four read tools);
2. host capabilities;
3. operator policy;
4. the parent-session ceiling;
5. the trusted manifest request;
6. run-specific human approval.

Any requested capability or tool absent from an upper bound blocks the entire
run. Project configuration may tighten but never widen authority. The service
allocates each member `limits.maxCostUsd / limits.maxMembers`; the sum of all
member ceilings therefore cannot exceed the approved team ceiling. It
preflights every member with that allocation before any member starts. Partial
admission never starts an agent.

A successful preflight records effective routes, actual model labels when
known, tools, capabilities, concurrency, timeout, and maximum cost. The
canonical preflight result forms `policyDigest`. An approval binds:

```ts
export interface ApprovalBinding {
  runId: string;
  manifestDigest: string;
  planDigest: string;
  policyDigest: string;
  requestedAction: "execute";
}
```

A digest or requested-action mismatch rejects execution. Slice 1 has no
predelegated model spending allowance: every model-requested run stops at
`awaiting_approval`, and only a human command can append `approval.granted`.

## Built-In Investigate DAG

`builtin/investigate` contains three members:

```text
architecture ─┐
              ├─> lead
risks ────────┘
```

`architecture` and `risks` are initially ready and may run concurrently up to
the effective concurrency limit. `lead` becomes ready only after both artifacts
have been securely written and re-read with matching digests. The lead receives
the objective plus an ordered structured dependency array. It never receives
an interpolated prompt template.

If any member fails, times out, or produces an invalid artifact, no new member
starts. The scheduler aborts running members, asks the host to contain remaining
work when supported, records cancellation/failure evidence, and appends one
terminal run event. A cancellation request likewise starts no new work and
propagates the abort signal to every running member.

## Event Authority

Each run is stored under:

```text
<teams-root>/<project-id>/<run-id>/
  writer.lock
  events.jsonl
  manifest.snapshot.json
  request.json
  artifacts/
    <member-id>/
      output.md
      result.json
```

`project-id` is SHA-256 of the canonical absolute project path. `run-id` is a
lowercase UUID. Directories are mode `0700`; files are mode `0600`. Run and
member IDs are validated before path construction.

`EventStore.createRun` creates the run directory and obtains `writer.lock` with
exclusive creation. The returned writer is the sole appender for that run in
the current process. Events are written with append semantics, a trailing
newline, and `fsync`; terminal append additionally syncs the run directory
before the writer closes. Existing event files are never rewritten, truncated,
or repaired.

Every line is one canonical JSON event:

```ts
export interface TeamEvent {
  v: 1;
  runId: string;
  seq: number;
  type: TeamEventType;
  actor: Actor;
  occurredAt: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
```

The first event has `seq: 1` and sixty-four zeroes as `prevHash`. `hash` is the
hex SHA-256 of canonical JSON for every field except `hash`. Each later event
increments `seq` by one and uses the preceding event hash. Timestamps are
validated RFC 3339 UTC values but are not ordering authority; sequence and hash
are.

Slice 1 uses these event types:

- `run.requested`;
- `manifest.snapshotted`;
- `policy.admitted` or `policy.blocked`;
- `run.awaiting_approval`;
- `approval.granted`;
- `run.started`;
- `member.ready`;
- `member.started`;
- `member.artifact_recorded`;
- `member.succeeded` or `member.failed`;
- `budget.observed`;
- `cancel.requested`;
- `member.cancelled`;
- `run.completed`, `run.failed`, `run.blocked`, or `run.cancelled`.

The reader fails closed on an empty file, malformed or blank line, invalid UTF-8,
unknown field/event type, wrong run ID, noncontiguous sequence, invalid
`prevHash`, invalid hash, oversized event line, duplicate terminal event, event
after terminal, or impossible lifecycle transition. A final torn/truncated line
is corruption, not an ignorable tail.

The projector is a pure fold over a validated history. Durable events are the
only status authority. UI callbacks and child streams are hints only. A
nonterminal history loaded without this process's live writer and member set is
projected as `incomplete`, never `running`. Slice 1 never resumes it and never
appends to it under the old run ID; the operator must request a new run.

Hash chaining detects accidental or local tampering but is not an authenticity
signature. Signed receipts are outside Slice 1.

## Artifact Integrity

Member text does not enter events. `FileArtifactStore.writeMember` validates the
member ID, UTF-8 encodes and bounds the text, writes `output.md` and canonical
`result.json` with exclusive creation, mode `0600`, and `fsync`, then returns
relative POSIX paths, byte counts, and SHA-256 digests. Paths must have exactly
`artifacts/<member-id>/output.md` and
`artifacts/<member-id>/result.json`; absolute paths, backslashes, dot segments,
symlinks, and escaped real paths are rejected.

`member.artifact_recorded` contains only the `ArtifactRef`. Before a dependency
is passed downstream and whenever `/team view` reads it, the store reopens both
regular files without following symlinks, rechecks containment, size, and
digest, parses strict result JSON, and verifies that the result member and run
identity match the event. Any mismatch fails the run. Events and summaries do
not silently substitute unverified child output.

## Scheduler And Service Lifecycle

The scheduler is a deterministic state machine with member states `pending`,
`ready`, `running`, `succeeded`, `failed`, and `cancelled`. Its public
transitions are:

```ts
createSchedule(team: CompiledTeam): ScheduleState;
readyMembers(state: ScheduleState): string[];
markStarted(state: ScheduleState, memberId: string): ScheduleState;
markSucceeded(state: ScheduleState, memberId: string): ScheduleState;
markFailed(state: ScheduleState, memberId: string): ScheduleState;
requestCancellation(state: ScheduleState): ScheduleState;
```

No transition mutates its input. `readyMembers` follows stable topological order
and never returns more than available concurrency slots. A dependent is ready
only when all dependencies succeeded.

`TeamService.request` resolves and compiles the manifest, validates the
objective, creates the run snapshots and writer, computes effective policy, and
preflights every member. It records either a terminal block or
`run.awaiting_approval`; it never starts a member.

`TeamService.approve` accepts only `Actor.kind === "human"`, verifies every
binding field against the admitted run, and records `approval.granted`.
`TeamService.execute` requires that approval and the same live admitted run,
records `run.started`, and drives scheduler transitions. It records every ready,
started, artifact, result, budget, cancellation, and terminal transition before
returning.

`TeamService.status` and `view` reconstruct from events and verified artifacts;
they do not trust in-memory summaries. `cancel` only reduces authority. It
records intent, aborts live member controllers, invokes containment, and records
a terminal cancellation after members settle. Cancelling an already terminal
run is idempotent and creates no event. A run abandoned by process exit is
`incomplete`; because resume is excluded, a later service instance refuses to
approve, execute, or append cancellation to it.

## Host Adapters

### Stock Pi 0.84.2

The stock adapter supports only `repo.read`, `read`, `grep`, `find`, and `ls`.
For Slice 1 it maps every semantic route to the active operator-selected session
model. A missing active model blocks preflight. This is host-owned routing: the
manifest cannot select a provider or model.

Each member uses `createAgentSession` with the active model, an in-memory
`SessionManager`, an explicit four-tool allowlist narrowed by the member, and a
`DefaultResourceLoader` with extensions, skills, prompts, themes, and project
context-file discovery disabled. The objective, member instructions, and
verified dependency records are serialized into one bounded data prompt. The
adapter requires finite nonnegative model pricing, reserves worst-case input
cost using one token per UTF-8 byte, and clones the model with an output-token
cap whose worst-case listed price fits the member allocation; a model whose
allocation cannot fund one output token is blocked. Zero-cost local models keep
their host maximum. Provider credentials remain in Pi's normal model runtime
and are not copied to files, argv, or team artifacts. The adapter subscribes
for result/usage evidence, aborts the session on signal, timeout, or observed
budget breach, and always disposes it.

### Alloy Pi 0.82.1

`lib/teams-host.mjs` is the only portable-Teams file that imports Alloy
internals. It maps semantic roles through `prepareAgentLaunch`, checks global
running count and spent cost through `agent-registry.mjs`, preserves the live
parent ceiling from `resolveParentChildSpawnOpts({ mode: "review" })`, and runs
admitted members through `spawnAgent`. `spawnAgent` in turn uses Alloy's
existing credential broker, child policy, `runChildAgent`, budget accounting,
and containment.

The adapter always passes the four-tool read-only allowlist (or a manifest
subset), `mode: "review"`, the admitted route/model, the manifest timeout, and
the tighter team/global budget. It never imports or modifies Auto, Fusion,
Fission, Forge, worktree code, or diagnostic workflows.

## Command And Tool Contract

Human commands are:

```text
/team list
/team inspect <team>
/team run <team> <objective>
/team status [run-id]
/team view <run-id> [member-id]
/team approve <run-id>
/team cancel <run-id>
```

`/team run` requests and preflights the run, then displays qualified team,
effective routes/models, capabilities, tools, concurrency, timeout, and maximum
cost before `ctx.ui.confirm`. Confirmation appends human approval and executes.
In noninteractive mode it stops at `awaiting_approval`. `/team approve` shows the
same bound policy and requires a human confirmation before approval and
execution. `/team status` without an ID uses the latest run for the current
project. Rendering is plain text through selection/notification or console
fallback; no custom TUI is created.

The model tool is named `team` and uses a closed TypeBox schema:

```ts
{
  action: "list" | "inspect" | "request" | "run" | "status" | "view" | "cancel";
  team?: string;
  objective?: string;
  runId?: string;
  memberId?: string;
}
```

Action-specific validation rejects missing, conflicting, or extraneous fields.
`list`, `inspect`, `status`, and `view` are read-only. `cancel` can only reduce
authority. In Slice 1, both model `request` and model `run` may create and
preflight a run but return `approval_required`; neither calls `approve` or
`execute`. The schema has no approve action, the dispatcher has no model
approval branch, and spoofing fields such as `approved`, `authorization`, or
`actor` is rejected by `additionalProperties: false`.

The command and tool receive the same `TeamService` instance from one
`registerTeams` call. They do not construct separate catalogs, stores, hosts,
or in-memory run maps.

## Validation Contract

Slice 1 is complete only when tests prove:

- strict manifest acceptance plus every YAML byte/node/depth/alias/tag/key and
  schema limit rejection before a model call;
- duplicate member and DAG cycle rejection;
- namespace collisions, unambiguous short names, and project-trust gating;
- semantic routes remain separate from actual models;
- capability/tool intersection is tighten-only;
- all-member preflight completes successfully before any member starts;
- no provider spend occurs before human approval;
- a model cannot approve or execute an unapproved run;
- single-writer sequencing and secure file modes;
- malformed, truncated, reordered, unknown, and hash-invalid logs fail closed;
- a nonterminal history projects as `incomplete`, not durably running;
- dependency scheduling, concurrency bounds, failure stop, timeout, abort
  propagation, containment, and terminal cancellation;
- artifact digest, size, identity, symlink, and path traversal enforcement;
- stock and Alloy adapter contracts use only read-only authority;
- a packed portable package registers once and works with stock Pi `0.84.2`;
- Alloy's root extension with Pi `0.82.1` registers `/team` and `team` exactly
  once;
- focused Teams tests, the full Alloy unit suite, integration suite, package
  verification, and whitespace checks pass.

## Residual Risks

- A stock read-only child shares the host Pi credential runtime. Slice 1 limits
  its tools and disables extension/resource discovery, but it is not a qualified
  write-capable containment boundary.
- Alloy process-group containment is stronger on POSIX than Windows. Slice 1 has
  no mutation authority; a later write-capable slice must separately qualify
  descendant containment on every supported platform.
- Hash chaining provides integrity detection, not signer authenticity.
- A process crash can leave a valid nonterminal log and writer lock. Slice 1
  deliberately reports it as incomplete and requires a new run rather than
  guessing recovery state.
- Read-only model calls still incur provider cost after explicit human approval.

These risks do not authorize mutation, recovery, or later-slice behavior.
