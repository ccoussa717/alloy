# Portable Pi Teams Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a portable, read-only `builtin/investigate` team with one authoritative service, durable verifiable runs, and compatible stock Pi and Alloy integrations.

**Architecture:** A host-neutral TypeScript core parses and compiles bounded YAML, intersects policy, validates a hash-chained event history, projects state, and schedules a role DAG. Injected file stores provide durable events/artifacts, stock Pi and Alloy adapters provide read-only member execution, and one `TeamService` instance serves both `/team` and the `team` tool.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9, Node test runner, `yaml@2.9.0`, `typebox`, `@earendil-works/pi-coding-agent` Alloy fork `0.82.1`, stock Pi `0.84.2`, npm packing.

**Spec:** `docs/superpowers/specs/2026-09-04-portable-pi-teams-slice1-design.md`

## Global Constraints

- Start from the supplied clean, main-derived worktree; do not merge, cherry-pick, or copy unrelated branch work.
- Slice 1 activates only `builtin/investigate` and only `repo.read` with `read`, `grep`, `find`, and `ls`.
- Target Alloy's pinned Pi fork `0.82.1` and stock Pi `0.84.2` through their common extension/SDK API subset.
- Keep `packages/pi-teams/src/core/` free of Pi and Alloy imports; all effects cross typed injected ports.
- Manifest ceilings are 65,536 UTF-8 bytes, 512 YAML nodes, depth 12, zero aliases, one document, 32 files and 1,048,576 aggregate bytes per catalog source, 5 members, concurrency 3, USD 2.00, and 300,000 ms.
- Text ceilings are 16,384 objective bytes, 1,024 description bytes, 8,192 instruction bytes per member, 1,048,576 output bytes per member, and 65,536 result-JSON bytes.
- Reject duplicate keys, anchors, aliases, merge keys, custom tags, unknown fields, duplicate IDs, unknown dependencies, cycles, unsupported routes/capabilities/tools, invalid limits, symlinks, and escaped paths before model use.
- Load `.pi/teams/*.yaml` only when the current host context affirmatively reports project trust; untrusted project files are not opened.
- All members must pass preflight before any member starts, and no provider call occurs before a matching human approval.
- A successful admission includes a positive integer `timeoutMs` no greater than the requested member timeout; effective timeouts are public, policy-hashed, and approval-bound.
- Optional stock `maxTimeoutMs` is an operator ceiling: validate a positive integer `<= 300_000` before SDK/model use and admit `min(requested timeoutMs, maxTimeoutMs)` without widening.
- Copy the common host abort signal into `TeamRunContext.signal`; it may only cancel work. Never inspect `TeamRunContext.runtime` or `MemberExecution.handle` in core code.
- On failure, timeout, or cancellation: abort first; immediately start per-running-member containment; bound containment and result settlement to 5,000 ms each; only then settle events. Any containment/settlement failure ends `run.failed`, never a falsely contained completion/cancellation.
- Allocate `limits.maxCostUsd / limits.maxMembers` to each member so aggregate member ceilings cannot exceed the approved team ceiling.
- Durable validated events are status authority; UI, process, callbacks, and child streams are not authority.
- Event history is append-only, single-writer, contiguous, canonical SHA-256 hash-chained, mode `0600` under mode `0700` directories, and fsynced.
- A valid nonterminal history without the current live writer/member set projects as `incomplete`; Slice 1 never resumes or appends to that run ID.
- The model tool has no approval path. Model `request` and `run` stop at `approval_required`; only the human command surface may approve.
- Register `/team` and `team` exactly once in Alloy and exactly once in a standalone package startup.
- Do not add repository mutation, resume, candidate create/apply, commit, push, publish, deploy, custom graphical TUI, or Auto/Fusion/Fission/Forge refactoring.

---

## File Map

- Create `packages/pi-teams/package.json`: standalone package metadata, peers, YAML dependency, Pi extension entry.
- Create `packages/pi-teams/tsconfig.json`: no-emit strict check against the installed Alloy Pi types.
- Create `packages/pi-teams/src/index.ts`: incremental public barrel; it exports a module only after that task creates the module.
- Create `packages/pi-teams/src/core/types.ts`: exact shared domain and port interfaces.
- Create `packages/pi-teams/src/core/limits.ts`: immutable Slice 1 ceilings and validators.
- Create `packages/pi-teams/src/core/manifest.ts`: strict YAML AST and manifest validation.
- Create `packages/pi-teams/src/core/catalog.ts`: namespaced catalog and resolution.
- Create `packages/pi-teams/src/core/compiler.ts`: DAG validation, normalization, ordering, and digests.
- Create `packages/pi-teams/src/core/policy.ts`: capability intersection and approval bindings.
- Create `packages/pi-teams/src/core/events.ts`: canonical JSON, event hashing, and chain/lifecycle validation.
- Create `packages/pi-teams/src/core/projection.ts`: pure authoritative run projection.
- Create `packages/pi-teams/src/core/scheduler.ts`: pure bounded DAG transitions.
- Create `packages/pi-teams/src/core/service.ts`: shared request/approval/execution/cancellation service.
- Create `packages/pi-teams/src/storage/catalog-loader.ts`: secure manifest discovery and trust gate.
- Create `packages/pi-teams/src/storage/file-event-store.ts`: secure snapshots and exclusive append writer.
- Create `packages/pi-teams/src/storage/file-artifact-store.ts`: secure member artifact storage and verification.
- Create `packages/pi-teams/src/adapters/stock-pi.ts`: stock Pi read-only session adapter.
- Create `packages/pi-teams/src/extension/index.ts`: standalone composition and one service instance.
- Create `packages/pi-teams/src/extension/commands.ts`: command parser and human-only approval flow.
- Create `packages/pi-teams/src/extension/tool.ts`: strict model tool and non-approval dispatch.
- Create `packages/pi-teams/src/extension/presentation.ts`: plain-text views.
- Create `packages/pi-teams/src/builtins/investigate.yaml`: the only active built-in.
- Create `packages/pi-teams/README.md`: standalone install, security, command, and run-state docs.
- Create `extensions/teams.ts`: Alloy composition wrapper.
- Create `lib/teams-host.mjs`: Alloy adapter over routing, registry, policy, and child execution.
- Modify `extensions/index.ts`: call `registerTeams(pi)` once.
- Modify `package.json`: ship the nested package; add direct YAML/dev TypeScript, typecheck, and stock smoke scripts.
- Modify `npm-shrinkwrap.json`: lock package metadata and direct dependencies.
- Modify `README.md`: document Slice 1 and link the portable package.
- Modify `lib/help-catalog.mjs`: add `/team` command help without adding a custom TUI.
- Create `test/unit/teams-package.test.mjs`: package boundary and common-API checks.
- Create `test/unit/teams-manifest.test.mjs`: strict YAML/schema/resource tests.
- Create `test/unit/teams-catalog.test.mjs`: namespace and trust tests.
- Create `test/unit/teams-compiler-policy.test.mjs`: DAG, route, policy, and digest tests.
- Create `test/unit/teams-events.test.mjs`: event hashing, exclusive writer, mode, and corruption tests.
- Create `test/unit/teams-projection.test.mjs`: lifecycle and incomplete-state tests.
- Create `test/unit/teams-artifacts.test.mjs`: artifact integrity and path tests.
- Create `test/unit/teams-scheduler.test.mjs`: ordering, concurrency, and cancellation tests.
- Create `test/unit/teams-service.test.mjs`: no-spend preflight, approval, run, and cancellation tests.
- Create `test/unit/teams-stock-adapter.test.mjs`: stock adapter contract tests with injected SDK.
- Create `test/unit/teams-extension.test.mjs`: command, tool, shared-service, and presentation tests.
- Create `test/unit/teams-alloy-host.test.mjs`: Alloy reuse and read-only clamp tests.
- Create `test/unit/teams-registration.test.mjs`: Alloy root exactly-once smoke test.
- Create `test/unit/teams-docs.test.mjs`: documentation/scope assertions.
- Create `test/integration/teams-stock-pi.e2e.test.mjs`: packed install and registration smoke against Pi `0.84.2`.

## Auxiliary Interface Contracts

These types complete the design vocabulary. Define them exactly where their
owning task says; later tasks must import them rather than restating variants.

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
export type CatalogFileSystem = typeof import("node:fs/promises");

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
    | "ModelRuntime"
    | "getAgentDir"
  >;
  agentDir?: string;
  maxTimeoutMs?: number;
}

export type TeamCommand =
  | { action: "list" }
  | { action: "inspect"; teamRef: string }
  | { action: "run"; teamRef: string; objective: string }
  | { action: "status"; runId?: string }
  | { action: "view"; runId: string; memberId?: string }
  | { action: "approve"; runId: string }
  | { action: "cancel"; runId: string };
export type ContextFactory = (
  ctx: ExtensionContext,
  source: "command" | "tool",
) => TeamRunContext;
```

Use this JSDoc contract in `lib/teams-host.mjs` so the adapter cannot drift from
Alloy's existing primitives:

```js
/**
 * @typedef {object} AlloyTeamsHostDependencies
 * @property {typeof import("./agent-orchestration.mjs").prepareAgentLaunch} [prepareAgentLaunch]
 * @property {typeof import("./agent-registry.mjs").getRunningAgentCount} [getRunningAgentCount]
 * @property {typeof import("./agent-registry.mjs").getAgentSpentCost} [getAgentSpentCost]
 * @property {typeof import("./agent-registry.mjs").spawnAgent} [spawnAgent]
 * @property {typeof import("./parent-policy.mjs").resolveParentChildSpawnOpts} [resolveParentChildSpawnOpts]
 */
```

No handwritten alternate signatures are permitted.

Every checkbox below is one editing or command action intended to take 2–5
minutes. Paste the shown fixture/assertion group as one edit; do not combine
adjacent checkboxes. Each task, rather than each checkbox, is the independently
reviewable unit and ends in one commit.

## Spec Coverage Map

| Design requirement | Implemented and proved by |
|---|---|
| Portable package, common `0.82.1` APIs, and exact domain types | Tasks 1, 11, 13, 15 |
| Strict YAML, fixed byte/node/depth/schema ceilings | Tasks 1–2 |
| Namespaces, deterministic resolution, secure loading, project trust | Task 3 |
| Deterministic DAG compilation, route/model separation, tighten-only policy, bound approval | Task 4 |
| Single-writer canonical hash chain, secure modes, fail-closed history | Tasks 5–6 |
| Durable projection and non-resumable `incomplete` state | Tasks 6, 9–10 |
| Digest-addressed, no-follow verified artifacts | Task 7 |
| Stable bounded dependency scheduling | Task 8 |
| Complete preflight, no pre-approval spend, human-only approval | Tasks 9, 12–13 |
| Success, failure, timeout, abort, containment, cancellation | Task 10 |
| Stock Pi read-only execution and resource isolation | Task 11 |
| Exact `builtin/investigate` DAG and plain-text command UI | Task 12 |
| Closed non-approving model tool and one shared service | Task 13 |
| Alloy primitive reuse and exactly-once root wiring | Task 14 |
| Packed stock `0.84.2`, Alloy `0.82.1`, full suites, docs, and scope audit | Task 15 |

The scope audit in Task 15 explicitly rejects mutation, writer roles, worktrees,
candidate create/apply, caller-branch commits, push/publication/deployment,
resume/recovery, later built-ins, custom graphical UI, changes to
Auto/Fusion/Fission/Forge, duplicate Alloy execution infrastructure, arbitrary
manifest commands/templates/model IDs, and manifest-defined authorization.

### Task 1: Establish The Portable Package And Exact Shared Types

**Files:**
- Create: `packages/pi-teams/package.json`
- Create: `packages/pi-teams/tsconfig.json`
- Create: `packages/pi-teams/src/index.ts`
- Create: `packages/pi-teams/src/core/types.ts`
- Create: `packages/pi-teams/src/core/limits.ts`
- Create: `test/unit/teams-package.test.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`

**Interfaces:**
- Consumes: Node.js `>=22.19.0`, root Pi `0.82.1`, TypeBox `1.1.38`.
- Produces: every Task 1 domain/port interface printed in the design's “Domain Interfaces” section; `TEAM_LIMITS`, `assertBoundedUtf8`, `assertIdentifier`, and a package barrel that exports only `core/types.ts` and `core/limits.ts`.

- [ ] **Step 1: Write the failing package-boundary test**

Create assertions that read both package manifests and verify exact values:

```js
assert.equal(portable.name, "@alloy/pi-teams");
assert.deepEqual(portable.pi.extensions, ["./src/extension/index.ts"]);
assert.equal(portable.dependencies.yaml, "2.9.0");
assert.equal(portable.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1 <0.85.0");
assert.equal(portable.peerDependencies.typebox, ">=1.1.38 <2");
assert.ok(root.files.includes("packages/pi-teams"));
assert.equal(root.dependencies.yaml, "2.9.0");
assert.equal(root.devDependencies.typescript, "5.9.3");
assert.equal(root.scripts["typecheck:teams"], "tsc -p packages/pi-teams/tsconfig.json");
```

Also read every file under `packages/pi-teams/src/core/`, when present, and
assert it contains neither `@earendil-works/pi-coding-agent` nor `/lib/` or
`lib/teams-host` import text. Read `src/index.ts` and build the expected ordered
exports as `./core/types.ts`, `./core/limits.ts`, plus
`./core/service.ts`, `./adapters/stock-pi.ts`, and `./extension/index.ts` only
when each designated file exists. Assert the barrel equals that dynamically
computed list and every export target exists. At Task 1 this proves the barrel
contains exactly types/limits; the same test remains green as Tasks 9, 11, and
13 add their module and export together.

- [ ] **Step 2: Run the test to verify the package is absent**

Run: `node --test test/unit/teams-package.test.mjs`
Expected: FAIL with `ENOENT` for `packages/pi-teams/package.json`.

- [ ] **Step 3: Add package metadata and strict TypeScript configuration**

Use this package contract:

```json
{
  "name": "@alloy/pi-teams",
  "version": "0.1.0",
  "description": "Portable read-only team orchestration for Pi",
  "type": "module",
  "private": true,
  "files": ["src", "README.md"],
  "exports": { ".": "./src/index.ts", "./extension": "./src/extension/index.ts" },
  "pi": { "extensions": ["./src/extension/index.ts"] },
  "engines": { "node": ">=22.19.0" },
  "dependencies": { "yaml": "2.9.0" },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.82.1 <0.85.0",
    "typebox": ">=1.1.38 <2"
  }
}
```

Set `strict`, `noEmit`, `module`/`moduleResolution: "NodeNext"`, target
`ES2022`, `allowImportingTsExtensions`, and include `src/**/*.ts` in
`tsconfig.json`. Add the exact root fields asserted above, then run
`npm install --package-lock-only --ignore-scripts` so `npm-shrinkwrap.json`
records the direct dependencies without changing versions opportunistically.

- [ ] **Step 4: Define the complete shared type vocabulary and limits**

Copy the design interfaces without weakening them and export these constants:

```ts
export const TEAM_LIMITS = Object.freeze({
  manifestBytes: 65_536,
  yamlNodes: 512,
  yamlDepth: 12,
  aliases: 0,
  documents: 1,
  catalogFiles: 32,
  catalogBytes: 1_048_576,
  members: 5,
  concurrency: 3,
  costUsd: 2,
  timeoutMs: 300_000,
  containmentTimeoutMs: 5_000,
  objectiveBytes: 16_384,
  descriptionBytes: 1_024,
  instructionBytes: 8_192,
  outputBytes: 1_048_576,
  resultBytes: 65_536,
  eventLineBytes: 65_536,
});
export const ZERO_HASH = "0".repeat(64);
export const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
```

`assertBoundedUtf8(value, field, maximum)` must require a well-formed string
(`Buffer.from(value).toString("utf8") === value`), a nonempty trimmed value,
and an inclusive UTF-8 byte ceiling. `assertIdentifier` applies `IDENTIFIER`.
At Task 1, `src/index.ts` exports only `./core/types.ts` and
`./core/limits.ts`; do not mention not-yet-created service, adapter, or extension
modules.

- [ ] **Step 5: Run focused checks**

Run: `node --test test/unit/teams-package.test.mjs && npm run typecheck:teams`
Expected: PASS; TypeScript reports zero errors against Pi `0.82.1`.

- [ ] **Step 6: Commit the package contract**

```bash
git add package.json npm-shrinkwrap.json packages/pi-teams/package.json packages/pi-teams/tsconfig.json packages/pi-teams/src/index.ts packages/pi-teams/src/core/types.ts packages/pi-teams/src/core/limits.ts test/unit/teams-package.test.mjs
git commit -m "feat: establish portable teams package contract"
```

### Task 2: Parse YAML With Strict Security And Resource Bounds

**Files:**
- Create: `packages/pi-teams/src/core/manifest.ts`
- Create: `test/unit/teams-manifest.test.mjs`

**Interfaces:**
- Consumes: `TEAM_LIMITS`, `TeamDefinition`, identifier/text validators, `yaml@2.9.0`.
- Produces: `parseTeamManifest(source: string, origin: string): TeamDefinition` and `ManifestError` with stable `code`.

- [ ] **Step 1: Write the first failing valid-manifest test**

Use one exact three-member document and define `errorCode(code)` as a predicate
checking `error.name === "ManifestError" && error.code === code`.

```js
assert.deepEqual(parseTeamManifest(VALID, "valid.yaml").spec.members[0].needs, []);
assert.equal(parseTeamManifest(VALID, "valid.yaml").metadata.name, "investigate");
```

- [ ] **Step 2: Run the valid-manifest test red**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="valid manifest"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `core/manifest.ts`.

- [ ] **Step 3: Add the smallest strict single-document parser**

```ts
export class ManifestError extends Error {
  constructor(readonly code: string, message: string, readonly origin: string) {
    super(`${code}:${origin}:${message}`);
    this.name = "ManifestError";
  }
}

export function parseTeamManifest(source: string, origin: string): TeamDefinition;
```

Use `YAML.parseDocument` with `strict: true`, `uniqueKeys: true`,
`maxAliasCount: 0`, and schema `core`; return only the exact valid shape and
normalize omitted `needs` to `[]`.

- [ ] **Step 4: Run the valid-manifest test green**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="valid manifest"`
Expected: PASS.

- [ ] **Step 5: Add the failing YAML syntax/feature matrix**

Generate two documents, duplicate mapping keys, anchor, alias, merge key,
`!!js/function`, `!custom`, `%TAG`, non-string keys, NaN/infinity, and malformed
UTF-8 represented by an unpaired surrogate.

```js
for (const [name, source, code] of YAML_FEATURE_REJECTIONS) {
  assert.throws(() => parseTeamManifest(source, `${name}.yaml`), errorCode(code));
}
```

- [ ] **Step 6: Run the YAML feature matrix red**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="YAML features"`
Expected: FAIL on the first currently accepted anchor/alias/tag case.

- [ ] **Step 7: Add the AST guard before conversion**

```ts
function inspectYamlNode(node: unknown, depth: number, state: { nodes: number }, origin: string): void;
function normalizePlainValue(value: unknown, origin: string): unknown;
```

Walk `document.contents` before `toJS`; reject aliases, anchors, merge key `<<`,
nonstandard tags, non-scalar string keys, multiple documents, and disallowed
directives. After conversion, recursively copy only arrays, finite primitive
scalars, and ordinary objects into null-prototype mappings. Never coerce scalar
types.

- [ ] **Step 8: Run the YAML feature matrix green**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="YAML features"`
Expected: PASS.

- [ ] **Step 9: Add failing AST and UTF-8 resource-bound tests**

```js
assert.throws(() => parseTeamManifest(oversizedUtf8(65_537), "bytes.yaml"), errorCode("manifest_bytes"));
assert.throws(() => parseTeamManifest(nestedYaml(13), "depth.yaml"), errorCode("manifest_depth"));
assert.throws(() => parseTeamManifest(nodeYaml(513), "nodes.yaml"), errorCode("manifest_nodes"));
```

Assert the inclusive 65,536-byte, depth-12, and 512-node counterparts reach
schema validation rather than their resource error.

- [ ] **Step 10: Run the resource-bound tests red**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="resource bounds"`
Expected: FAIL because byte/node/depth ceilings are not all enforced.

- [ ] **Step 11: Enforce byte, node, and depth ceilings**

```ts
assertManifestBytes(source, TEAM_LIMITS.manifestBytes, origin);
inspectYamlNode(document.contents, 1, { nodes: 0 }, origin);
```

Reject more than 65,536 UTF-8 bytes, 512 visited AST nodes, or depth 12 before
`toJS`; treat an unpaired surrogate as invalid UTF-8.

- [ ] **Step 12: Run the resource-bound tests green**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="resource bounds"`
Expected: PASS.

- [ ] **Step 13: Add failing exact-schema and semantic tests**

For each top-level/nested object add one unknown key and assert
`manifest_unknown_field`. Assert wrong version/kind, duplicate/invalid IDs,
empty/repeated arrays, unsupported route, `repo.write-isolated`, `bash`, unknown
and self dependencies, mismatched `maxMembers`, concurrency above members,
booleans/fractions, zero/negative limits, and each text/numeric ceiling.

```js
assert.throws(() => parseTeamManifest(VALID.replace("planning", "implementation"), "route.yaml"), errorCode("manifest_route"));
assert.throws(() => parseTeamManifest(VALID.replace("repo.read", "repo.write-isolated"), "cap.yaml"), errorCode("manifest_capability"));
assert.throws(() => parseTeamManifest(VALID.replace("find, ls", "find, bash"), "tool.yaml"), errorCode("manifest_tool"));
```

- [ ] **Step 14: Run schema/semantic tests red**

Run: `node --test test/unit/teams-manifest.test.mjs --test-name-pattern="schema|semantic"`
Expected: FAIL on the first unknown or unsupported value not yet rejected.

- [ ] **Step 15: Add exact-key and field validators**

```ts
function assertExactKeys(value: object, allowed: readonly string[], field: string, origin: string): void;
function validateLimits(value: unknown, memberCount: number, origin: string): TeamLimits;
function validateMember(value: unknown, origin: string): TeamMember;
```

Require exact keys/types, unique nonempty arrays, identifiers, supported role,
capability and tools, known non-self dependencies, all text ceilings, integer
limits, `maxMembers === members.length`, and
`maxConcurrency <= maxMembers`. Reject before returning `TeamDefinition`.

- [ ] **Step 16: Run the complete parser and type checks green**

Run: `node --test test/unit/teams-manifest.test.mjs && npm run typecheck:teams`
Expected: PASS, including every syntax, abuse, schema, and boundary case.

- [ ] **Step 17: Commit strict manifest parsing**

```bash
git add packages/pi-teams/src/core/manifest.ts test/unit/teams-manifest.test.mjs
git commit -m "feat: reject unsafe team manifests"
```

### Task 3: Load Namespaced Catalogs Behind Project Trust

**Files:**
- Create: `packages/pi-teams/src/core/catalog.ts`
- Create: `packages/pi-teams/src/storage/catalog-loader.ts`
- Create: `test/unit/teams-catalog.test.mjs`

**Interfaces:**
- Consumes: `parseTeamManifest`, `TeamDefinition`, namespaces, catalog limits.
- Produces: `createTeamCatalog(entries): TeamCatalog`, `TeamCatalog.list()`, `TeamCatalog.resolve(ref)`, and `loadTeamCatalog({ builtinsDir, userDir, projectDir, projectTrusted })`.

- [ ] **Step 1: Write failing namespace and resolution tests**

Construct in-memory entries and assert deterministic qualified sorting, exact
qualified lookup, unique short-name lookup, ambiguous short-name failure that
lists every candidate, and duplicate qualified-name failure.

```js
assert.equal(catalog.resolve("builtin/investigate").ref, "builtin/investigate");
assert.equal(unique.resolve("solo").ref, "user/solo");
assert.throws(() => catalog.resolve("investigate"), /catalog_ambiguous.*builtin\/investigate.*project\/investigate/);
```

- [ ] **Step 2: Write failing secure-loader and trust tests**

Use temporary built-in, user, and project directories. Assert an untrusted load
never calls injected `lstat`, `realpath`, `readdir`, or `open` beneath the
project path. Assert
a trusted load includes `project/<metadata.name>`. Add lexical-order, 33-file,
1,048,577-byte aggregate, symlinked-file, symlinked-directory, escaped-realpath,
non-regular-file, duplicate-qualified-name, and non-`.yaml` cases.

```js
const untrusted = await loadTeamCatalog({
  builtinsDir,
  userDir,
  projectDir,
  projectTrusted: false,
  fs: spyingFs,
});
assert.equal(projectOpenCalls, 0);
assert.deepEqual(untrusted.list().map(entry => entry.ref), ["builtin/investigate"]);
```

- [ ] **Step 3: Run the catalog test and verify missing exports**

Run: `node --test test/unit/teams-catalog.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `core/catalog.ts`.

- [ ] **Step 4: Implement deterministic catalog resolution**

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
export function createTeamCatalog(entries: CatalogEntry[]): TeamCatalog;
```

Freeze copied entries, index by qualified ref and short metadata name, sort by
qualified ref, and raise stable `catalog_duplicate`, `catalog_not_found`, and
`catalog_ambiguous` errors. Do not apply namespace precedence.

- [ ] **Step 5: Implement bounded no-follow catalog loading**

```ts
export async function loadTeamCatalog(input: {
  builtinsDir: string;
  userDir: string;
  projectDir: string;
  projectTrusted: boolean;
  fs?: CatalogFileSystem;
}): Promise<TeamCatalog>;
```

Skip the project directory branch before any filesystem operation when
`projectTrusted` is false. For each included source, resolve the root, reject a
symlink root, sort directory entries, accept at most 32 `.yaml` regular files,
open with `O_RDONLY | O_NOFOLLOW` when available, compare pre-open `lstat` and
post-open `fstat` identity, verify realpath containment, enforce per-file and
aggregate byte limits, decode fatal UTF-8, parse, and assign the source
namespace. Close every descriptor in `finally`.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/unit/teams-catalog.test.mjs test/unit/teams-manifest.test.mjs`
Expected: PASS; the untrusted project open count remains zero.

- [ ] **Step 7: Commit catalog trust boundaries**

```bash
git add packages/pi-teams/src/core/catalog.ts packages/pi-teams/src/storage/catalog-loader.ts test/unit/teams-catalog.test.mjs
git commit -m "feat: gate namespaced team catalogs by trust"
```

### Task 4: Compile DAGs And Tighten Authority

**Files:**
- Create: `packages/pi-teams/src/core/compiler.ts`
- Create: `packages/pi-teams/src/core/policy.ts`
- Create: `test/unit/teams-compiler-policy.test.mjs`

**Interfaces:**
- Consumes: `CatalogEntry`, `CompiledTeam`, `HostCapabilities`, `Admission`, Slice 1 supported capability/tool sets.
- Produces: `compileTeam(entry): CompiledTeam`, `canonicalJson(value): string`, `sha256Canonical(value): string`, `intersectMemberPolicy`, `policyDigest`, `approvalBinding`, and `verifyApprovalBinding`.

- [ ] **Step 1: Write failing compiler tests**

Assert stable declaration-order topological sorting; sorted `needs` in digest
input; rejection of self-dependency, unknown dependency, duplicate member,
two-node and longer cycles; and digest changes for any manifest or plan field.
Also assert the same semantic object with different mapping insertion order has
the same digest.

```js
assert.deepEqual(compileTeam(entry).topologicalOrder, ["architecture", "risks", "lead"]);
assert.throws(() => compileTeam(cyclicEntry), /dag_cycle:architecture -> lead -> architecture/);
assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
```

- [ ] **Step 2: Write failing policy and approval tests**

Test package/host/operator/parent/manifest intersection. A missing requested
capability or tool blocks rather than silently widening or dropping it. Assert
routes stay semantic in the compiled plan while `effectiveModel` exists only in
admission. Assert per-member budget is `maxCostUsd / maxMembers`. Assert a host
`timeoutMs` equal to or below the requested timeout is admitted and retained,
while zero, negative, fractional, nonfinite, or larger timeouts block. Change
each approval field separately and assert verification fails; then change only
one admitted member's effective timeout, recompute `policyDigest`, and assert
the previously issued binding fails.

```js
assert.deepEqual(admitted.effectiveCapabilities, ["repo.read"]);
assert.deepEqual(admitted.effectiveTools, ["read", "grep"]);
assert.equal(admitted.maxCostUsd, 2 / 3);
assert.equal(admitted.timeoutMs, 120_000);
assert.equal(compiled.definition.spec.members[0].route, "research");
assert.equal("model" in compiled.definition.spec.members[0], false);
assert.throws(() => verifyApprovalBinding(expected, { ...expected, planDigest: "0".repeat(64) }), /approval_binding/);
```

- [ ] **Step 3: Run tests to verify missing compiler/policy modules**

Run: `node --test test/unit/teams-compiler-policy.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement canonical compilation**

`canonicalJson` recursively sorts object keys, preserves array order, rejects
undefined/non-finite/non-JSON values, and serializes without whitespace. Use
Node `createHash("sha256")`. Kahn-sort ready nodes by declaration index and, on
failure, run a deterministic DFS to report one concrete cycle. Freeze the
normalized definition and produce both design-specified digests.

```ts
export function canonicalJson(value: unknown): string;
export function sha256Canonical(value: unknown): string;
export function compileTeam(entry: CatalogEntry): CompiledTeam;
```

- [ ] **Step 5: Implement fail-closed policy intersection and bindings**

```ts
export const PACKAGE_CAPABILITIES = ["repo.read"] as const;
export const PACKAGE_TOOLS = ["read", "grep", "find", "ls"] as const;
export function intersectMemberPolicy(input: PolicyIntersectionInput): PolicyDecision;
export function policyDigest(admissions: Admission[], limits: TeamLimits): string;
export function approvalBinding(runId: string, team: CompiledTeam, digest: string): ApprovalBinding;
export function verifyApprovalBinding(expected: ApprovalBinding, actual: ApprovalBinding): void;
```

Treat a blocked host admission as blocked. For an admitted result, require every
effective capability/tool in package, host, and manifest sets; require the
semantic route and member allocation to match; require integer
`0 < admission.timeoutMs <= input.timeoutMs`; and preserve manifest tool order.
Hash the public admissions, including each effective `timeoutMs`, plus effective
limits, where effective `maxConcurrency` is the lesser of manifest and host
ceilings. Host preflight remains responsible for operator and parent ceilings,
and its opaque token is never hashed. Approval binds the resulting policy
digest, so any effective-timeout change invalidates approval.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `node --test test/unit/teams-compiler-policy.test.mjs && npm run typecheck:teams`
Expected: PASS.

- [ ] **Step 7: Commit compiler and policy**

```bash
git add packages/pi-teams/src/core/compiler.ts packages/pi-teams/src/core/policy.ts test/unit/teams-compiler-policy.test.mjs
git commit -m "feat: compile bounded team authority"
```

### Task 5: Create Hash-Chained Append-Only Event Authority

**Files:**
- Create: `packages/pi-teams/src/core/events.ts`
- Create: `packages/pi-teams/src/storage/file-event-store.ts`
- Create: `test/unit/teams-events.test.mjs`

**Interfaces:**
- Consumes: `canonicalJson`, `ZERO_HASH`, `TeamEvent`, `EventStore`, `EventWriter`, secure run/snapshot identifiers.
- Produces: `hashEvent`, `validateEventHistory`, and `createFileEventStore({ root, now, randomUUID, fs })`.

- [ ] **Step 1: Write failing chain and corruption tests**

Create a deterministic three-event chain and assert sequence 1 starts with
`ZERO_HASH`, every hash recomputes, and stable input yields stable hashes. For
each mutation—blank line, malformed/truncated final JSON, unknown field/type,
wrong version/run ID, skipped/duplicate sequence, wrong `prevHash`, changed
payload/hash, event line over 65,536 bytes, second terminal, and event after
terminal—assert a stable corruption error.

```js
assert.equal(events[0].seq, 1);
assert.equal(events[0].prevHash, ZERO_HASH);
assert.equal(hashEvent(stripHash(events[1])), events[1].hash);
assert.throws(() => validateEventHistory(tampered, runId), /event_hash/);
```

- [ ] **Step 2: Write failing filesystem authority tests**

With a temporary root, assert `createRun` creates `0700` directories,
`manifest.snapshot.json`, `request.json`, `events.jsonl`, and `writer.lock` as
`0600`; a second writer gets `event_writer_claimed`; appends never change the
existing prefix; each append ends in newline; injected `fsync` is called; and a
terminal append closes/releases the live writer without permitting the old run
to be reopened for append.

- [ ] **Step 3: Run event tests and observe missing exports**

Run: `node --test test/unit/teams-events.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `core/events.ts`.

- [ ] **Step 4: Implement exact event hashing and validation**

```ts
export const TEAM_EVENT_TYPES = [
  "run.requested", "manifest.snapshotted", "policy.admitted", "policy.blocked",
  "run.awaiting_approval", "approval.granted", "run.started", "member.ready",
  "member.started", "member.artifact_recorded", "member.succeeded",
  "member.failed", "budget.observed", "cancel.requested", "member.cancelled",
  "run.completed", "run.failed", "run.blocked", "run.cancelled",
] as const;
export function hashEvent(eventWithoutHash: Omit<TeamEvent, "hash">): string;
export function validateEventHistory(events: unknown[], expectedRunId: string): TeamEvent[];
```

Require exact keys, UUID run IDs, positive contiguous integer sequences, RFC
3339 UTC timestamps, known actors/types, plain-object payloads, and one allowed
terminal event at the end. Encode canonical JSON plus `\n`; do not accept or
repair partial tails.

- [ ] **Step 5: Implement the exclusive filesystem writer**

```ts
export function createFileEventStore(input: FileEventStoreOptions): EventStore;
```

Derive only validated `<root>/<project-id>/<run-id>` paths. Create directories
with `0o700`, snapshots with `wx`/`0o600`, lock with `wx`/`0o600`, and event file
with append-only `a`/`0o600`. Keep last sequence/hash in the returned writer,
write exactly one line per append, `fsync` the event descriptor after every
append, sync the directory at terminal close, and never expose an API that
rewrites/truncates events. On read, fatal-decode UTF-8, reject a missing final
newline, split without discarding blank lines, parse every line, then validate.

- [ ] **Step 6: Run event tests and typecheck**

Run: `node --test test/unit/teams-events.test.mjs && npm run typecheck:teams`
Expected: PASS; prefix, file-mode, fsync, and second-writer assertions pass.

- [ ] **Step 7: Commit event authority**

```bash
git add packages/pi-teams/src/core/events.ts packages/pi-teams/src/storage/file-event-store.ts test/unit/teams-events.test.mjs
git commit -m "feat: persist authoritative team event chains"
```

### Task 6: Project Durable State Without False Running

**Files:**
- Create: `packages/pi-teams/src/core/projection.ts`
- Create: `test/unit/teams-projection.test.mjs`

**Interfaces:**
- Consumes: validated `TeamEvent[]`.
- Produces: `projectTeamRun(events, { live }): TeamRunView` and lifecycle rejection used by event validation.

- [ ] **Step 1: Write failing lifecycle projection tests**

Cover blocked, awaiting approval, live running, completed, failed, cancelled,
and nonterminal persisted histories. Assert a nonterminal history with
`live: false` is `incomplete`, including one whose last event is
`member.started`. Assert `live: true` permits `running` only after `run.started`.
Assert impossible transitions such as success before start, lead ready before
its dependencies, approval before awaiting, and completion with a running
member fail closed.

```js
assert.equal(projectTeamRun(nonterminal, { live: false }).status, "incomplete");
assert.equal(projectTeamRun(nonterminal, { live: true }).status, "running");
assert.throws(() => projectTeamRun(successBeforeStart, { live: false }), /event_transition/);
```

- [ ] **Step 2: Run the projection test and verify missing module**

Run: `node --test test/unit/teams-projection.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement a pure lifecycle fold**

```ts
export function projectTeamRun(
  events: TeamEvent[],
  options: { live: boolean },
): TeamRunView;
```

Initialize all members from the snapshotted plan, apply each known event through
an explicit state-transition table, retain digests/admission/artifact refs and
observed usage, reject payload identity mismatches, and require one terminal
state. After folding, map a nonterminal durable history to `incomplete` unless
`options.live` is true and `run.started` occurred. Do not consult processes,
files, or wall clock.

- [ ] **Step 4: Make event reads reject impossible lifecycle histories**

Call the projection lifecycle validator from `validateEventHistory` after chain
validation with a validation mode that does not rewrite the final status.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/unit/teams-projection.test.mjs test/unit/teams-events.test.mjs`
Expected: PASS; corruption and impossible lifecycle cases both fail closed.

- [ ] **Step 6: Commit authoritative projection**

```bash
git add packages/pi-teams/src/core/projection.ts packages/pi-teams/src/core/events.ts test/unit/teams-projection.test.mjs test/unit/teams-events.test.mjs
git commit -m "feat: project durable team lifecycle"
```

### Task 7: Store And Re-Verify Member Artifacts

**Files:**
- Create: `packages/pi-teams/src/storage/file-artifact-store.ts`
- Create: `test/unit/teams-artifacts.test.mjs`

**Interfaces:**
- Consumes: `ArtifactStore`, `ArtifactRef`, `MemberResult`, canonical JSON, output/result ceilings.
- Produces: `createFileArtifactStore({ root, fs }): ArtifactStore`.

- [ ] **Step 1: Write failing artifact round-trip and integrity tests**

Assert output/result modes `0600`, member directory `0700`, exact relative POSIX
paths, byte counts, SHA-256 digests, verified round-trip, and deterministic
result JSON. Then mutate each file, size, digest, run/member identity, and path;
replace files/directories with symlinks; use absolute, backslash, `.` and `..`
path traversal inputs; exceed both byte limits; and assert failure before text is
returned.

```js
assert.deepEqual(ref.outputPath, "artifacts/architecture/output.md");
assert.equal((await store.readVerified(projectId, runId, ref)).text, "evidence\n");
await fs.writeFile(outputPath, "changed\n");
await assert.rejects(store.readVerified(projectId, runId, ref), /artifact_digest/);
```

- [ ] **Step 2: Run the artifact test and verify missing module**

Run: `node --test test/unit/teams-artifacts.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exclusive artifact writes**

```ts
export function createFileArtifactStore(input: FileArtifactStoreOptions): ArtifactStore;
```

Validate run/member IDs before joining. Create only
`artifacts/<member-id>/output.md` and `result.json`; write with `wx`, `0o600`,
fatal UTF-8, inclusive limits, and `fsync`. Canonical result JSON records
`runId`, `memberId`, `ok`, `model`, `usage`, and optional `error`, but not a
second copy of text. Return hashes and exact byte counts after successful sync.

- [ ] **Step 4: Implement no-follow verified reads**

Require exact path strings derived from `memberId`. For directories and files,
reject symlinks and escaped realpaths, open no-follow, compare `lstat`/`fstat`,
bound before read, verify bytes and digest with timing-safe equal-length
comparison, fatal-decode, parse strict JSON, and validate exact result keys and
identity before returning.

- [ ] **Step 5: Run artifact tests and typecheck**

Run: `node --test test/unit/teams-artifacts.test.mjs && npm run typecheck:teams`
Expected: PASS.

- [ ] **Step 6: Commit artifact integrity**

```bash
git add packages/pi-teams/src/storage/file-artifact-store.ts test/unit/teams-artifacts.test.mjs
git commit -m "feat: verify team member artifacts"
```

### Task 8: Build The Pure Bounded DAG Scheduler

**Files:**
- Create: `packages/pi-teams/src/core/scheduler.ts`
- Create: `test/unit/teams-scheduler.test.mjs`

**Interfaces:**
- Consumes: `CompiledTeam`, immutable member states.
- Produces: `createSchedule`, `readyMembers`, `markStarted`, `markSucceeded`, `markFailed`, and `requestCancellation` with the exact design signatures.

- [ ] **Step 1: Write failing scheduler transition tests**

Assert the investigate schedule initially returns architecture and risks, never
more than free concurrency slots; lead remains pending until both predecessors
succeed; declaration order is stable; inputs are not mutated; illegal starts,
duplicate terminal transitions, dependency failure, and start-after-cancel are
rejected. Assert cancellation marks pending/ready members cancelled while
leaving running members available for service-driven abort/settlement.

```js
const initial = createSchedule(compiled);
assert.deepEqual(readyMembers(initial), ["architecture", "risks"]);
const oneRunning = markStarted(initial, "architecture");
assert.deepEqual(readyMembers(oneRunning), ["risks"]);
assert.deepEqual(initial.members.architecture.status, "ready");
```

- [ ] **Step 2: Run the scheduler test and verify missing module**

Run: `node --test test/unit/teams-scheduler.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement immutable deterministic transitions**

```ts
export function createSchedule(team: CompiledTeam): ScheduleState;
export function readyMembers(state: ScheduleState): string[];
export function markStarted(state: ScheduleState, memberId: string): ScheduleState;
export function markSucceeded(state: ScheduleState, memberId: string): ScheduleState;
export function markFailed(state: ScheduleState, memberId: string): ScheduleState;
export function requestCancellation(state: ScheduleState): ScheduleState;
```

Clone only changed records, recompute readiness after success, enforce
`running < maxConcurrency`, and block every dependent of a failed/cancelled
member. Return ready IDs in compiled topological order.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/unit/teams-scheduler.test.mjs test/unit/teams-compiler-policy.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit the scheduler**

```bash
git add packages/pi-teams/src/core/scheduler.ts test/unit/teams-scheduler.test.mjs
git commit -m "feat: schedule bounded team dags"
```

### Task 9: Request, Preflight, And Approve Through One Service

**Files:**
- Create: `packages/pi-teams/src/core/service.ts`
- Create: `test/unit/teams-service.test.mjs`
- Modify: `packages/pi-teams/src/index.ts`

**Interfaces:**
- Consumes: `TeamCatalog`, compiler/policy, `TeamHost`, `EventStore`, `ArtifactStore`, projection.
- Produces: `createTeamService({ catalogFor, eventStore, artifactStore, host, now, randomUUID }): TeamService`; live admitted run records remain private; the public barrel adds only the now-existing service factory.

- [ ] **Step 1: Write failing request/preflight tests with fakes**

Create fake stores and a host whose `preflightMember` records calls and whose
`runMember` increments `providerCalls`. Assert request validates objective size,
resolves/compiles once, preflights all three members in declaration order,
passes `2 / 3` cost and `300000` timeout to each, accepts each host's
positive narrowed effective timeout, and appends requested, snapshot, admitted,
awaiting events with public effective timeouts included. Assert
`providerCalls === 0`.

For each member position, return a blocked admission and assert all preflights
still settle, `policy.blocked` then `run.blocked` are terminal, and no member
runs. Reject mismatched project trust/catalog data before writer creation.

```js
const view = await service.request({ teamRef: "builtin/investigate", objective: "Map auth", actor: modelActor, context });
assert.equal(view.status, "awaiting_approval");
assert.equal(providerCalls, 0);
assert.deepEqual(preflightCalls.map(call => call.input.maxCostUsd), [2 / 3, 2 / 3, 2 / 3]);
```

- [ ] **Step 2: Write failing human-only approval tests**

Assert model actors are rejected, each digest mismatch is rejected without an
event, exact human binding appends one approval, duplicate approval is
idempotent without another event, blocked/terminal/incomplete runs cannot be
approved, and approval still does not call `runMember`.

- [ ] **Step 3: Run the service test and verify missing module**

Run: `node --test test/unit/teams-service.test.mjs --test-name-pattern="request|preflight|approve"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `core/service.ts`.

- [ ] **Step 4: Implement request and all-member preflight**

```ts
export function createTeamService(input: TeamServiceDependencies): TeamService;
```

Keep a private `Map<string, LiveRun>` containing writer, compiled team,
admissions/tokens, context, binding, scheduler, abort controllers, and running
`MemberExecution` records. Validate the objective before creating a run. Write
immutable snapshots, append request and snapshot events, ask host capabilities,
intersect package/host bounds, and await `Promise.allSettled` for every member
preflight. Validate each successful host admission with integer
`0 < timeoutMs <= requested timeoutMs`. If any fails, append the complete
blocked reasons and terminal block. If all pass, strip opaque tokens from the
canonical admission payload while retaining effective `timeoutMs`, compute the
policy digest/binding, append admitted and awaiting events, and return a
projection. Never call `runMember`.

- [ ] **Step 5: Implement human approval binding**

Accept only `{ kind: "human", id: nonempty }`, require the same live admitted
run, compare all five binding fields in constant-time for digest strings,
append `approval.granted`, and return the projected view. Keep approval and
execution separate methods.

- [ ] **Step 6: Export the now-existing service factory**

Add only `export { createTeamService } from "./core/service.ts";` to
`packages/pi-teams/src/index.ts`; keep future stock-adapter and extension paths
absent.

- [ ] **Step 7: Run focused service tests**

Run: `node --test test/unit/teams-service.test.mjs --test-name-pattern="request|preflight|approve" && npm run typecheck:teams`
Expected: PASS; provider call count remains zero through approval, the public
admissions retain narrowed timeouts, and the barrel resolves no future module.

- [ ] **Step 8: Commit request authority**

```bash
git add packages/pi-teams/src/core/service.ts packages/pi-teams/src/index.ts test/unit/teams-service.test.mjs
git commit -m "feat: preflight and approve team runs"
```

### Task 10: Execute, Fail, Timeout, And Cancel Through Durable Transitions

**Files:**
- Modify: `packages/pi-teams/src/core/service.ts`
- Modify: `test/unit/teams-service.test.mjs`

**Interfaces:**
- Consumes: Task 9 live admission records, scheduler, host, artifact verification, synchronous `MemberExecution` handles, and required `TeamHost.containMember(input, context, signal): Promise<void>`.
- Produces: operational `execute`, `cancel`, `status`, and `view` methods on the existing `TeamService`; private abort-first bounded containment/settlement helpers use `TEAM_LIMITS.containmentTimeoutMs === 5_000`.

- [ ] **Step 1: Write failing successful-execution tests**

Use controllable promises to prove architecture/risks start together, lead does
not start until both artifacts are written and re-verified, dependencies reach
lead in topological order, concurrency never exceeds two, every member gets
`2 / 3` cost, and events occur in ready/start/artifact/success order followed by
observed budgets and one completion.

```js
await tick();
assert.deepEqual(started.sort(), ["architecture", "risks"]);
assert.equal(started.includes("lead"), false);
releaseArchitecture();
await tick();
assert.equal(started.includes("lead"), false);
releaseRisks();
await completion;
assert.equal((await service.status(runId, context)).status, "completed");
```

- [ ] **Step 2: Write failing failure, timeout, and cancellation tests**

Cover member rejection, invalid artifact on dependency read, timeout at each
member's effective admitted timeout (including a host-narrowed timeout), caller
signal abort, and `/cancel` while two members run. Record call order and assert
all running controllers abort first, then `containMember` is invoked once for
every running
`{ runId, memberId, handle }`, and no member result is awaited before all
containment calls have started. Make the first containment call throw
synchronously and assert later running members still receive containment calls.
Assert no later starts, member cancellation evidence, and exactly one terminal
event.

Add a containment rejection case, a containment promise that never settles, and
a member result that ignores abort and never settles. Advance a fake clock by
5,000 ms and assert each run returns without deadlock as `run.failed` with the
specific containment/settlement reason; it must not report `run.cancelled` or
`run.completed`. Assert successful bounded containment plus settlement permits
`run.cancelled`, and terminal cancel is idempotent. Construct a valid
nonterminal history in a fresh service and assert status `incomplete` while
approve/execute/cancel reject `resume_unsupported` without append.

- [ ] **Step 3: Run execution tests and verify missing behavior**

Run: `node --test test/unit/teams-service.test.mjs --test-name-pattern="execute|failure|timeout|cancel|incomplete"`
Expected: FAIL because Task 9 does not drive members or cancellation.

- [ ] **Step 4: Implement the scheduler execution loop**

Append `run.started`, emit each newly ready event once, and launch only the IDs
returned by `readyMembers`. Give each member its own controller linked to the
run controller and a timer using `admission.timeoutMs`; pass that same effective
value as `MemberRunInput.timeoutMs`. Call synchronous `host.runMember`, verify
its returned `runId`/`memberId`, and retain its opaque handle and result promise
before yielding. On success, bound/write/re-read the artifact before
`member.artifact_recorded` and `member.succeeded`; append `budget.observed` from
returned usage and reject nonfinite/negative or allocation-exceeding cost. Pass
only verified dependency text/refs to a successor. Continue via `Promise.race`
until complete or a failure occurs.

- [ ] **Step 5: Implement terminal failure and cancellation settlement**

On any error, stop launching and abort every running controller first. Without
awaiting between members, invoke `host.containMember` for every running
execution using its `{ runId, memberId, handle }` and a containment signal. Wrap
each invocation independently so a synchronous throw from one host call cannot
prevent containment from starting for later members. Race every containment
promise against the fixed 5,000 ms deadline; only after all containment calls
have started and their bounded outcomes are
known may the service await member results, also raced against a fresh 5,000 ms
settlement deadline. Never use unbounded `Promise.allSettled` on child results.

Append member failure/cancellation evidence once, then exactly one terminal
event. `cancel` first appends `cancel.requested`. Emit `run.cancelled` only when
all containment and settlement outcomes succeed; any containment rejection,
containment timeout, or settlement timeout emits `run.failed` with stable reason
`containment_failed`, `containment_timeout`, or `member_settlement_timeout` and
must not claim completion/cancellation. A member result counts as settled when
it fulfills or rejects; ordinary abort rejection does not turn a successfully
contained cancellation into failure. Close the writer and remove the live
record only after terminal sync. A terminal cancel returns current projection
without append; an absent/nonterminal persisted run rejects
`resume_unsupported`.

- [ ] **Step 6: Implement event-backed status and verified view**

`status(runId, context)` reads and validates project-scoped events and calls
`projectTeamRun` with `live` only when this exact service owns a live record. If
`runId` is undefined, use `eventStore.list(context.projectId)` and choose the
latest run by the last validated event timestamp with run ID as deterministic
tie-breaker. `view(runId, memberId, context)` obtains the projected artifact ref
and calls `readVerified(context.projectId, runId, ref)`; no in-memory output is
returned.

- [ ] **Step 7: Run the complete service/core group**

Run: `node --test test/unit/teams-service.test.mjs test/unit/teams-scheduler.test.mjs test/unit/teams-artifacts.test.mjs test/unit/teams-events.test.mjs test/unit/teams-projection.test.mjs`
Expected: PASS with no unhandled rejections or leaked timers.

- [ ] **Step 8: Commit durable execution**

```bash
git add packages/pi-teams/src/core/service.ts test/unit/teams-service.test.mjs
git commit -m "feat: execute and cancel durable team runs"
```

### Task 11: Adapt Read-Only Stock Pi Sessions

**Files:**
- Create: `packages/pi-teams/src/adapters/stock-pi.ts`
- Create: `test/unit/teams-stock-adapter.test.mjs`
- Modify: `packages/pi-teams/src/index.ts`

**Interfaces:**
- Consumes: common SDK `createAgentSession`, `DefaultResourceLoader`, `SessionManager.inMemory`, `ModelRuntime`, and `getAgentDir`; runtime context contains Pi `ExtensionContext`.
- Produces: `createStockPiHost({ sdk?, agentDir?, maxTimeoutMs? }): TeamHost` with only read-only capabilities, a validated tighten-only operator timeout ceiling, synchronous `MemberExecution` handles, required per-member containment, and a newly added barrel export.

- [ ] **Step 1: Write failing capabilities/preflight tests**

Inject a fake SDK and context model. Assert capabilities contain exactly
`repo.read` and the four tools, every semantic route resolves to the active
model ID, missing model blocks, unsupported tools block, finite nonnegative
pricing is required, and the equal member allocation produces an output token
cap whose listed worst-case input plus output price does not exceed the
allocation. Put these exact cases in a test named `stock timeout ceiling` and
count SDK/model inspection calls:

```js
const preserved = await createStockPiHost({ sdk }).preflightMember(
  { member, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, context,
);
assert.equal(preserved.ok && preserved.timeoutMs, 300_000);

const boundary = await createStockPiHost({ sdk, maxTimeoutMs: 300_000 }).preflightMember(
  { member, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, context,
);
assert.equal(boundary.ok && boundary.timeoutMs, 300_000);

const narrowedHost = createStockPiHost({ sdk, maxTimeoutMs: 120_000 });
const narrowed = await narrowedHost.preflightMember(
  { member, maxCostUsd: 2 / 3, timeoutMs: 300_000 }, context,
);
assert.equal(narrowed.ok && narrowed.timeoutMs, 120_000);

const shorterRequest = await narrowedHost.preflightMember(
  { member, maxCostUsd: 2 / 3, timeoutMs: 60_000 }, context,
);
assert.equal(shorterRequest.ok && shorterRequest.timeoutMs, 60_000);

for (const value of [null, true, "120000", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 300_001]) {
  const callsBefore = sdkModelCalls;
  assert.throws(
    () => createStockPiHost({ sdk, maxTimeoutMs: value }),
    /stock_timeout_ceiling/,
  );
  assert.equal(sdkModelCalls, callsBefore);
}
```

Also assert capabilities remain exactly `repo.read` and the four tools, every
semantic route resolves to the active model ID, missing model blocks,
unsupported tools block, pricing is finite/nonnegative, and the output token cap
fits the allocation. The preservation case proves absence of the option does
not narrow; the shorter-request case proves a larger valid ceiling never
widens.

- [ ] **Step 2: Write failing run/abort/resource-isolation tests**

Assert `createAgentSession` receives only the admitted cloned model, an isolated
in-memory `ModelRuntime`, `noTools: "all"`, the exact custom-tool names plus
matching repository-confined custom definitions, an in-memory session manager,
and a resource loader configured with
`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and
`noContextFiles` all true. Assert the prompt is JSON data with objective,
instructions, and ordered verified dependencies; it contains no interpolation
syntax. Assert `runMember` synchronously returns `{ runId, memberId, handle, result }`
before the child result settles. While it is pending, call `containMember` with
that exact identity/handle and assert it aborts and disposes only that session.
Assert result/usage extraction, effective admission timeout/signal calls
`session.abort`, and `session.dispose` occurs once on success, failure, and
containment. Assert no write/edit/bash tool is enabled.

- [ ] **Step 3: Run adapter tests and verify missing module**

Run: `node --test --test-name-pattern="stock timeout ceiling" test/unit/teams-stock-adapter.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` because `stock-pi.ts` does not exist;
the named test is the exact Critical D red and must later fail with the narrowed
value still `300000` or a missing `stock_timeout_ceiling` if an implementer
first creates only a module shell.

- [ ] **Step 4: Implement strict stock preflight and budget cap**

```ts
export function createStockPiHost(input?: StockPiHostOptions): TeamHost;
```

Read Pi context only from `TeamRunContext.runtime`. Preflight may use only the
synchronous active model, catalog, and auth-status snapshots and must not
resolve auth, create a runtime, access the network, or mutate state. Calculate
worst-case input as one token per UTF-8 byte for the fixed prompt envelope and
maximum possible verified dependencies. Convert model prices (per million tokens) to cost,
subtract from the member allocation, and clone `model.maxTokens` down to the
largest affordable integer output count. Block if price metadata is invalid or
a priced model cannot fund one token. Validate `input.maxTimeoutMs` once during
host construction: when defined it must be an integer in
`1..TEAM_LIMITS.timeoutMs`, otherwise throw `stock_timeout_ceiling` before
reading the SDK or context model. Preflight returns
`Math.min(MemberPreflightInput.timeoutMs, maxTimeoutMs)` when configured and the
requested value otherwise. It never widens a shorter request. Keep the host's
selected provider/model; never parse a model from route or manifest.

- [ ] **Step 5: Implement isolated read-only in-process sessions**

Construct `SettingsManager`/`DefaultResourceLoader` with project resource
discovery disabled, call `reload`, then `createAgentSession` with
`SessionManager.inMemory(context.cwd)` and exact tools. After human approval,
resolve the complete public parent auth shape once. Snapshot effective/native
provider identity, safely canonicalized registered config, and auth status
before and after that asynchronous call; reject drift and hostile/proxy/accessor
config before runtime creation. Create an isolated `ModelRuntime` with explicit
in-memory credential/model stores and network refresh disabled. Verify isolated
request auth by case-insensitively merging admitted model headers over resolved
provider headers using Pi's precedence, then comparing API key, headers, and
environment. Pass `noTools: "all"`, the exact admitted
custom-tool names in `tools`, and only matching repository-confined custom
definitions. `runMember` immediately
returns a host-owned handle and an async result that performs setup. Serialize a
bounded JSON prompt, subscribe for final usage/model evidence, link abort and
`admission.timeoutMs` to `session.abort()`, call `session.prompt`, take final
assistant text, validate usage, and dispose/unsubscribe/clear timers in
`finally`. `containMember` validates exact run/member/handle identity and aborts
plus disposes that tracked session; it must be safe while async setup is still
pending.

- [ ] **Step 6: Export the now-existing stock host factory**

Add only `export { createStockPiHost } from "./adapters/stock-pi.ts";` to
`packages/pi-teams/src/index.ts`; retain the Task 1 and Task 9 exports and keep
future extension paths absent.

- [ ] **Step 7: Run adapter, service, and type checks**

Run: `node --test --test-name-pattern="stock timeout ceiling" test/unit/teams-stock-adapter.test.mjs && node --test test/unit/teams-stock-adapter.test.mjs test/unit/teams-service.test.mjs && npm run typecheck:teams`
Expected: the named Critical D test PASS first, then all adapter/service tests and
typecheck PASS against root Pi `0.82.1`; absent-ceiling preservation,
300,000 ms valid-boundary acceptance, 120,000 ms narrowing, shorter-request
non-widening, all nine invalid values with zero SDK/model access, live handle,
and containment assertions pass.

- [ ] **Step 8: Commit stock Pi adaptation**

```bash
git add packages/pi-teams/src/adapters/stock-pi.ts packages/pi-teams/src/index.ts test/unit/teams-stock-adapter.test.mjs
git commit -m "feat: run read-only teams on stock pi"
```

### Task 12: Ship The Investigate Built-In And Human `/team` Flow

**Files:**
- Create: `packages/pi-teams/src/builtins/investigate.yaml`
- Create: `packages/pi-teams/src/extension/presentation.ts`
- Create: `packages/pi-teams/src/extension/commands.ts`
- Create: `test/unit/teams-extension.test.mjs`

**Interfaces:**
- Consumes: shared `TeamService`, design command grammar, `TeamRunView`.
- Produces: `parseTeamCommand`, `registerTeamCommand(pi, service, contextFactory)`, `formatTeamList`, `formatTeamInspect`, `formatTeamRun`, and `formatMemberView`.

- [ ] **Step 1: Write failing built-in and parser tests**

Read the YAML and assert exact `builtin/investigate` limits/members/DAG, only
read authority, and no review/feature YAML exists. Test every valid command and
reject missing/excess arguments, empty objectives, unknown actions, and invalid
run/member IDs.

```js
assert.deepEqual(parseTeamCommand("run builtin/investigate map auth"), {
  action: "run", teamRef: "builtin/investigate", objective: "map auth",
});
assert.deepEqual(parseTeamCommand("status"), { action: "status" });
assert.throws(() => parseTeamCommand("approve"), /team_usage/);
```

- [ ] **Step 2: Write failing command authorization/presentation tests**

With one fake service instance, assert list/inspect/status/view dispatch exactly;
`run` requests first, displays qualified team/effective routes/models/tools,
effective run concurrency, every member's admitted `timeoutMs`, and the USD
ceiling, and invokes approve then execute only after a
true interactive confirmation. False confirmation and `hasUI: false` stop at
awaiting approval. `/team approve` confirms the stored binding before approve
and execute. `/team cancel` calls only cancel. Assert formatters are plain
strings and never call widget/panel/sidebar methods.

- [ ] **Step 3: Run extension tests and verify missing modules**

Run: `node --test test/unit/teams-extension.test.mjs --test-name-pattern="command|presentation|builtin"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Add the exact approved built-in**

Create the design YAML verbatim: architecture (`research`) and risks (`review`)
with no dependencies, lead (`planning`) needing both, concurrency 2, cost 2,
timeout 300000, members 3, and only `repo.read` plus the four read tools.

- [ ] **Step 5: Implement strict command parsing and text renderers**

```ts
export function parseTeamCommand(args: string): TeamCommand;
export function registerTeamCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  service: TeamService,
  contextFactory: ContextFactory,
): void;
```

Split only the action/team/run/member prefixes; retain the remaining run text
as one trimmed objective and enforce its UTF-8 bound through the service. Render
fixed labels and JSON-safe scalar values; never render opaque admission tokens
or raw event payloads.

- [ ] **Step 6: Implement the human-only approval flow**

Register `team` once as a command. Build actor `{ kind: "human", id: "pi-user" }`.
For run/approve, render the exact stored approval binding and policy—including
each admitted member's effective `timeoutMs`—before `ctx.ui.confirm`. If no
dialog-capable UI exists, notify/print
`approval_required` and return. Call `service.approve` only in the confirmed
branch, followed by `service.execute`. Do not expose approval through a shared
generic dispatcher callable by the tool.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/unit/teams-extension.test.mjs --test-name-pattern="command|presentation|builtin" && npm run typecheck:teams`
Expected: PASS.

- [ ] **Step 8: Commit the built-in and command**

```bash
git add packages/pi-teams/src/builtins/investigate.yaml packages/pi-teams/src/extension/presentation.ts packages/pi-teams/src/extension/commands.ts test/unit/teams-extension.test.mjs
git commit -m "feat: add investigate team command"
```

### Task 13: Add The Non-Approving Model Tool And Shared Registration

**Files:**
- Create: `packages/pi-teams/src/extension/tool.ts`
- Create: `packages/pi-teams/src/extension/index.ts`
- Modify: `packages/pi-teams/src/index.ts`
- Modify: `test/unit/teams-extension.test.mjs`

**Interfaces:**
- Consumes: command registration, stock host, catalog/file stores, `TeamService`.
- Produces: `registerTeamTool`, default portable extension, and `registerTeams(pi, options?)`; exactly one service is passed to both surfaces; the barrel adds named `registerTeams` and the portable default export only after `extension/index.ts` exists.

- [ ] **Step 1: Write failing closed-schema and action tests**

Capture the tool registration and assert name `team`,
`additionalProperties: false`, exact enum actions, bounded fields, and no
`approve` property/action. For every action, test required and forbidden field
combinations. Explicitly send `approved`, `authorization`, and `actor` and
assert schema rejection. Assert model `request` and `run` call only
`service.request` and return `approval_required`; `cancel` calls only cancel;
read actions cannot mutate.

```js
assert.equal(tool.name, "team");
assert.equal(tool.parameters.additionalProperties, false);
assert.equal(tool.parameters.properties.action.anyOf.some(item => item.const === "approve"), false);
assert.equal(approveCalls, 0);
assert.equal(executeCalls, 0);
```

- [ ] **Step 2: Write failing shared-service and duplicate-call tests**

Inject factories returning identifiable objects. Call `registerTeams` once and
assert one service construction, one command, one tool, and strict object
identity for the service received by both registration functions. Call the
returned standalone default extension once and assert the same. Do not make
`registerTeams` silently tolerate a second call on the same API; tests should
fail it with `teams_already_registered` so duplicate wiring is visible.

- [ ] **Step 3: Run tool/registration tests and observe missing modules**

Run: `node --test test/unit/teams-extension.test.mjs --test-name-pattern="tool|shared|register"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extension/tool.ts`.

- [ ] **Step 4: Implement action-specific tool validation and dispatch**

Use TypeBox union objects for each action, all with
`additionalProperties: false`, rather than one permissive optional-field object.
Use `Type.Literal` actions and identifier/string bounds. The execute function creates actor `{ kind: "model", id: context.model ?
`${context.model.provider}/${context.model.id}` : "no-active-model" }` and a
tool context. For
`request` and `run`, call request once and return a text result whose structured
details contain `status: "approval_required"`, run ID, and binding. Never call
approve/execute from this module.

- [ ] **Step 5: Compose one service and register once**

```ts
export interface RegisterTeamsOptions {
  host?: TeamHost;
  eventStore?: EventStore;
  artifactStore?: ArtifactStore;
  catalogFor?: TeamServiceDependencies["catalogFor"];
  agentDir?: string;
  teamsRoot?: string;
}
export function registerTeams(pi: ExtensionAPI, options?: RegisterTeamsOptions): TeamService;
export default function portableTeamsExtension(pi: ExtensionAPI): void;
```

Use a module `WeakSet<object>` to reject duplicate API registration. Resolve
built-in/user/project roots, pass `ctx.isProjectTrusted()` to catalog loading,
derive project ID from SHA-256 of canonical absolute cwd, copy `ctx.signal` to
the explicit cancellation field, place `ctx` in the opaque runtime field,
create exactly one service, then pass it to command and tool registration. Add
`export { registerTeams, default } from "./extension/index.ts";` to the public
barrel only in this task, retaining the earlier types/limits, service, and stock
host exports.

- [ ] **Step 6: Run all extension tests and typecheck**

Run: `node --test test/unit/teams-extension.test.mjs && npm run typecheck:teams`
Expected: PASS; command/tool captured service identities are equal and model
approval/execution call counts are zero.

- [ ] **Step 7: Commit shared extension surfaces**

```bash
git add packages/pi-teams/src/extension/tool.ts packages/pi-teams/src/extension/index.ts packages/pi-teams/src/index.ts test/unit/teams-extension.test.mjs
git commit -m "feat: expose one safe teams service"
```

### Task 14: Reuse Alloy Routing, Registry, Policy, And Child Execution

**Files:**
- Create: `lib/teams-host.mjs`
- Create: `extensions/teams.ts`
- Create: `test/unit/teams-alloy-host.test.mjs`
- Create: `test/unit/teams-registration.test.mjs`
- Modify: `extensions/index.ts`

**Interfaces:**
- Consumes: `prepareAgentLaunch`, `getRunningAgentCount`, `getAgentSpentCost`, `spawnAgent`, `resolveParentChildSpawnOpts`, portable `registerTeams`.
- Produces: `createAlloyTeamsHost(dependencies?): TeamHost` with narrowed effective timeout, synchronous `MemberExecution`, and per-member `containMember`; plus the `registerTeams(pi)` Alloy wrapper.

- [ ] **Step 1: Write failing Alloy adapter contract tests**

Inject spies for every Alloy primitive. Assert semantic route reaches
`prepareAgentLaunch.requestedRole`, tools are always a manifest subset of the
four read tools, current running/cost values are passed, and failed routing
blocks. Assert the
successful admission includes integer `timeoutMs` no greater than the requested
value, and a widening router/host value blocks. On run, assert `spawnAgent`
receives the preflight route/model, `mode: "review"`, `background: false`, parent
policy snapshot, effective admitted timeout, signal, credential broker values,
and member cost allocation. Assert `runMember` synchronously returns the exact
run/member identity and opaque handle while `spawnAgent` is pending. Invoke
`containMember` during execution and assert it aborts only that tracked handle.
Assert no import text
references `auto-workflow`, `fusion`, `fission`, `forge`, `worktree`, or
diagnostics.

```js
assert.equal(prepareCalls[0].requestedRole, "research");
assert.deepEqual(prepareCalls[0].tools, ["read", "grep", "find", "ls"]);
assert.deepEqual(parentCalls, [{ mode: "review" }]);
assert.equal(admission.timeoutMs, 120_000);
assert.equal(spawnCalls[0].timeoutMs, admission.timeoutMs);
assert.equal(spawnCalls[0].budgetUsd, 2 / 3);
```

- [ ] **Step 2: Write the failing Alloy exactly-once root smoke test**

Follow `test/unit/fission-registration.test.mjs`: use a Proxy API, isolated
`HOME`, `ALLOY_HOME`, and `PI_CODING_AGENT_DIR`, import
`extensions/index.ts?<unique>`, start once, and count registrations.

```js
assert.equal(registrations.filter(item => item.kind === "command" && item.name === "team").length, 1);
assert.equal(registrations.filter(item => item.kind === "tool" && item.name === "team").length, 1);
```

Also inspect root `package.json.pi.extensions` and assert it remains only
`["./extensions/index.ts"]`.

- [ ] **Step 3: Run Alloy tests and observe missing registration**

Run: `node --test test/unit/teams-alloy-host.test.mjs test/unit/teams-registration.test.mjs`
Expected: FAIL with missing `lib/teams-host.mjs` and zero Teams registrations.

- [ ] **Step 4: Implement the narrow Alloy adapter**

```js
/** @typedef {(dependencies?: AlloyTeamsHostDependencies) => TeamHost} CreateAlloyTeamsHost */
```

Export `createAlloyTeamsHost(dependencies = {})` with that function type.

The returned host ID is `alloy`; its static package capability is `repo.read`,
its tool set is `read`, `grep`, `find`, `ls`, and its maximum concurrency comes
from the stricter team/global routing result.

Fill each method only through the injected/default approved primitives. Convert
`prepareAgentLaunch` success into an admission with an opaque frozen token and
an integer effective `timeoutMs` no greater than the requested value; convert
routing or timeout widening failures to stable reasons. `runMember` synchronously
creates a tracked host handle, starts `spawnAgent`, and returns its mapped result
promise. `containMember` validates exact run/member/handle identity and aborts
only that in-flight adapter-owned handle through Alloy's existing signal/child
containment path; it does not scan or kill unrelated agents. Do not implement a
router, credential copy, subprocess spawn, ledger, process-containment layer,
or worktree path here.

- [ ] **Step 5: Wire Alloy once through the root extension**

`extensions/teams.ts` imports portable `registerTeams` under an alias, creates
the Alloy host, passes Alloy's teams run root, and exports one
`registerTeams(pi)` function. Add one import and one call at the end of
`extensions/index.ts`. Do not add the portable nested entry to root
`pi.extensions`.

- [ ] **Step 6: Run Alloy adapter and registration tests**

Run: `node --test test/unit/teams-alloy-host.test.mjs test/unit/teams-registration.test.mjs test/unit/fission-registration.test.mjs`
Expected: PASS; existing Fission and new Teams each register once.

- [ ] **Step 7: Commit Alloy adaptation**

```bash
git add lib/teams-host.mjs extensions/teams.ts extensions/index.ts test/unit/teams-alloy-host.test.mjs test/unit/teams-registration.test.mjs
git commit -m "feat: adapt portable teams into Alloy"
```

### Task 15: Prove Stock Packaging, Document Scope, And Run Broad Validation

**Files:**
- Create: `packages/pi-teams/README.md`
- Create: `test/integration/teams-stock-pi.e2e.test.mjs`
- Create: `test/unit/teams-docs.test.mjs`
- Modify: `README.md`
- Modify: `lib/help-catalog.mjs`
- Modify: `package.json`
- Modify: `npm-shrinkwrap.json`

**Interfaces:**
- Consumes: completed portable package and Alloy wiring.
- Produces: `npm run test:teams:stock`, user/maintainer documentation, and final validation evidence.

- [ ] **Step 1: Write the failing documentation boundary test**

Assert the package/root/help documents name `builtin/investigate`, `/team list`,
`/team run`, `team` tool, stock `0.84.2`, Alloy `0.82.1`, project trust,
`incomplete`, human approval, effective timeout narrowing, stock
`maxTimeoutMs` operator-ceiling validation, and bounded abort-before-containment. Assert they explicitly state no mutation,
resume, apply, push, publish, deploy, custom TUI, or Auto/Fusion/Fission
refactor in Slice 1.

```js
for (const phrase of ["builtin/investigate", "0.82.1", "0.84.2", "approval_required", "incomplete"]) {
  assert.match(allDocumentation, new RegExp(phrase.replace("/", "\\/"), "i"));
}
```

- [ ] **Step 2: Write the failing packed stock Pi smoke test**

Create a temporary consumer, run `npm pack packages/pi-teams`, install the
tarball plus exactly `@earendil-works/pi-coding-agent@0.84.2` and compatible
TypeBox with `--ignore-scripts --no-audit --no-fund`, assert installed package
version and peer version, and assert the common SDK exports
`createAgentSession`, `DefaultResourceLoader`, `SettingsManager`,
`SessionManager`, `ModelRuntime`, and `getAgentDir`. Import its extension entry,
invoke it with a Proxy API, and assert exactly one command/tool named `team`. Invoke list through the
captured command and tool with temporary homes and assert both include
`builtin/investigate` without a provider call.

Gate network execution behind `ALLOY_RUN_TEAMS_STOCK_E2E=1`, matching the
existing installer-test convention. Add script:

```json
"test:teams:stock": "ALLOY_RUN_TEAMS_STOCK_E2E=1 node --test --test-force-exit test/integration/teams-stock-pi.e2e.test.mjs"
```

- [ ] **Step 3: Run new tests and observe missing docs/script**

Run: `node --test test/unit/teams-docs.test.mjs test/integration/teams-stock-pi.e2e.test.mjs`
Expected: documentation test FAIL; stock test reports SKIP without the opt-in.

- [ ] **Step 4: Write exact standalone and Alloy documentation**

Document installation through Pi package settings, three manifest locations,
trust gating, fixed resource/security limits, all seven command forms, all tool
actions, human approval bound to effective member timeouts, event/artifact
paths, `incomplete` crash behavior, the 5,000 ms abort-before-containment and
settlement bounds, fail-closed containment errors, stock active-model routing,
Alloy primitive reuse, and every Slice 1 exclusion.
Add a concise root README section linking `packages/pi-teams/README.md`. Add
plain `/team` help text to `lib/help-catalog.mjs`; do not add graphical UI code.

- [ ] **Step 5: Lock the final scripts and package graph**

Add `test:teams:stock` exactly, then run:

```bash
npm install --package-lock-only --ignore-scripts
npm run typecheck:teams
node --test test/unit/teams-*.test.mjs
```

Expected: shrinkwrap is current, typecheck passes, and all Teams unit tests pass.

- [ ] **Step 6: Run the real stock `0.84.2` packed smoke**

Run: `npm run test:teams:stock`
Expected: PASS; npm installs the packed `@alloy/pi-teams@0.1.0` with stock
`@earendil-works/pi-coding-agent@0.84.2`, and list registration/dispatch succeeds
exactly once without provider use.

- [ ] **Step 7: Run focused Alloy/package validation**

Run:

```bash
node --test \
  test/unit/teams-*.test.mjs \
  test/unit/fission-registration.test.mjs \
  test/unit/pi-package.test.mjs
npm run typecheck:teams
npm pack packages/pi-teams --json --dry-run
```

Expected: all tests/typechecks PASS; dry-run contents include package source,
built-in, and README and exclude root Alloy internals/tests.

- [ ] **Step 8: Run broad repository validation**

Run:

```bash
npm test
npm run test:integration
git diff --check
```

Expected: full Alloy unit and integration suites PASS and no whitespace errors.
The opt-in stock smoke has already run separately; normal integration may report
that test SKIP when its environment flag is absent.

- [ ] **Step 9: Audit scope and authority mechanically**

Run:

```bash
rg -n "repo\.write|candidate\.(create|apply)|git\.push|publish|deploy|resume|register.*Widget|setWidget|auto-workflow|lib/fusion|lib/fission|forge-workflow" packages/pi-teams extensions/teams.ts lib/teams-host.mjs
rg -n "registerCommand\(\"team\"|name:\s*\"team\"" packages/pi-teams extensions/teams.ts extensions/index.ts
git status --short
git diff --stat HEAD
```

Expected: the first command matches documentation/rejection text only, not an
enabled capability/import/UI path; the second shows one command definition and
one tool definition; status lists only Task 15 files; the diff contains no
unrelated files.

- [ ] **Step 10: Self-review spec coverage, forbidden markers, and type consistency**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
markers = ["T" + "BD", "T" + "ODO", "implement " + "later", "fill in " + "details", "Similar to " + "Task", "appropriate error " + "handling"]
paths = [Path("docs/superpowers/plans/2026-09-04-portable-pi-teams-slice1.md")]
paths.extend(Path("packages/pi-teams").rglob("*"))
hits = [(str(path), marker) for path in paths if path.is_file() for marker in markers if marker in path.read_text(errors="ignore")]
raise SystemExit(f"placeholder markers: {hits}" if hits else 0)
PY
node --test test/unit/teams-*.test.mjs
npm run typecheck:teams
```

Expected: placeholder scan has no matches; tests/typecheck PASS. Manually compare the
design validation list with Tasks 1–15 and verify every item has a named test.
Verify `TeamHost`, `Admission`, `MemberPreflightInput`, `MemberRunInput`,
`MemberExecution`, `MemberContainmentInput`, `TeamService`, `ApprovalBinding`,
`ArtifactRef`, and `TeamRunView` names and properties are identical at every
producer and consumer. Verify successful admissions retain effective
`timeoutMs`, `policyDigest` changes when only that timeout changes, and
`runMember`/`containMember` signatures match both adapters and the service.
Verify `StockPiHostOptions.maxTimeoutMs?: number` matches the spec, rejects
invalid values before SDK/model use, and implements
`min(requested timeoutMs, maxTimeoutMs)` without widening. Verify the documented
`StockPiHostOptions.sdk` common subset contains `ModelRuntime` and `getAgentDir`
alongside `createAgentSession`, `DefaultResourceLoader`, `SettingsManager`, and
`SessionManager`, with no post-0.82.1 API. Finally, inspect the barrel at the
Task 1, Task 9, Task 11, and Task 13 commit boundaries and confirm no commit
imports a module that does not yet exist.

- [ ] **Step 11: Commit documentation and final verification wiring**

```bash
git add packages/pi-teams/README.md test/integration/teams-stock-pi.e2e.test.mjs test/unit/teams-docs.test.mjs README.md lib/help-catalog.mjs package.json npm-shrinkwrap.json
git commit -m "docs: publish portable teams slice one"
```

## Final Acceptance Checklist

Run after all task commits from a clean index:

```bash
npm run typecheck:teams
node --test test/unit/teams-*.test.mjs
npm run test:teams:stock
npm test
npm run test:integration
git diff --check
git status --short --branch
```

Expected: every command passes; the final status shows the intended branch with
no staged or unstaged files. Review the complete main-derived range with:

```bash
git diff --stat main...HEAD
git diff --name-status main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: only the File Map implementation/documentation files are present,
commits follow the task sequence, and no repository mutation team, resume path,
candidate apply, push, publish, deploy, custom graphical TUI, or
Auto/Fusion/Fission/Forge refactor appears.
