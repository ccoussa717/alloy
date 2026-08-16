# Ollama Manual and Live Catalog Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new models from a reachable Ollama server appear in Alloy even when `~/.pi/agent/models.json` contains an older manual Ollama catalog, while preserving manual provider and model overrides.

**Architecture:** Keep `extensions/local-engines.ts` as the single provider-registration boundary. Parse manual provider definitions, merge live and manual model lists by exact ID, and register one complete extension model list through Pi's existing composition layer; leave the preloaded manual provider untouched whenever discovery cannot supply a live catalog.

**Tech Stack:** TypeScript extension code, Node.js test runner, Pi provider-composition API, fake HTTP Ollama integration server.

## Global Constraints

- Live-discovered model order comes first; manual-only model IDs follow in configured order.
- For matching IDs, supported manual model fields override live-discovered fields.
- Duplicate manual IDs collapse deterministically with the last manual definition winning.
- Manual provider `baseUrl`, `api`, `apiKey`, `headers`, and `authHeader` remain authoritative.
- Discovery disabled, failed, malformed, or empty leaves a preloaded manual provider untouched.
- No user configuration file is rewritten.
- No provider secret is logged, returned, or persisted by the extension.
- One local provider's failure must not suppress other local providers.
- Do not modify package dependencies, lockfiles, TUI behavior, hosted providers, or local-engine wire protocols.

---

## File Structure

| File | Responsibility |
|---|---|
| `extensions/local-engines.ts` | Parse manual providers, merge model catalogs, and register live overlays safely |
| `test/unit/local-engines-extension.test.mjs` | Prove merge precedence, ordering, fallback, and provider isolation |
| `test/integration/local-engines.e2e.test.mjs` | Prove a real Alloy `--list-models` process exposes live, overridden, and manual-only Ollama models |

---

### Task 1: Merge manual and live provider catalogs

**Files:**
- Modify: `extensions/local-engines.ts:21-166`
- Test: `test/unit/local-engines-extension.test.mjs:6-136`

**Interfaces:**
- Consumes: live discovery result `{ ok, baseUrl, models }` and the `providers` object from `~/.pi/agent/models.json`.
- Produces: `LocalEnginesDependencies.manualProviders?: () => Map<string, Record<string, unknown>>` and one `pi.registerProvider(id, config)` call containing the merged model list.

- [ ] **Step 1: Replace the old precedence test with failing merge and fallback tests**

Replace `manual models.json providers take precedence over successful discovery` with tests shaped as follows:

```javascript
test("manual Ollama metadata overrides live discovery without hiding new models", async () => {
  const registrations = [];
  const manualProviders = new Map([["ollama", {
    baseUrl: "http://manual.invalid/v1",
    api: "openai-completions",
    apiKey: "$MANUAL_OLLAMA_KEY",
    headers: { "X-Manual": "yes" },
    authHeader: true,
    compat: { supportsDeveloperRole: false },
    models: [
      { id: "existing", name: "Manual Existing", contextWindow: 65536 },
      { id: "manual-only", name: "Manual Alias", maxTokens: 2048 },
    ],
  }]]);

  await registerLocalEngines(fakePi(registrations), {
    discover: async () => discoveryBundle([
      discoveredModel("existing", { contextWindow: 8192 }),
      discoveredModel("new-live"),
    ]),
    loadConfig: () => ({}),
    manualProviders: () => manualProviders,
    env: {},
  });

  const ollama = registrations.find(({ id }) => id === "ollama");
  assert.deepEqual(ollama.config.models.map(({ id }) => id), [
    "existing", "new-live", "manual-only",
  ]);
  assert.equal(ollama.config.models[0].name, "Manual Existing");
  assert.equal(ollama.config.models[0].contextWindow, 65536);
  assert.equal(ollama.config.baseUrl, "http://manual.invalid/v1");
  assert.equal(ollama.config.apiKey, "$MANUAL_OLLAMA_KEY");
  assert.deepEqual(ollama.config.headers, { "X-Manual": "yes" });
  assert.equal(ollama.config.authHeader, true);
});

test("failed or empty discovery leaves a manual provider registered by Pi", async () => {
  for (const ollama of [
    { ok: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [], error: "offline" },
    { ok: true, provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] },
  ]) {
    const registrations = [];
    const unregistrations = [];
    await registerLocalEngines(fakePi(registrations, unregistrations), {
      discover: async () => discoveryBundle([], ollama),
      loadConfig: () => ({}),
      manualProviders: () => new Map([["ollama", { models: [{ id: "manual" }] }]]),
      env: {},
    });
    assert.equal(registrations.some(({ id }) => id === "ollama"), false);
    assert.equal(unregistrations.includes("ollama"), false);
  }
});
```

Add local test helpers `fakePi`, `discoveredModel`, and `discoveryBundle` that return the complete shapes already repeated in this test file. Add a separate duplicate test asserting discovered order first and the last duplicate manual definition wins.

- [ ] **Step 2: Run the focused unit test and observe the red baseline**

Run:

```bash
node --test test/unit/local-engines-extension.test.mjs
```

Expected: FAIL because `manualProviders` is not a dependency and the current implementation skips every manual provider.

- [ ] **Step 3: Parse manual provider definitions instead of IDs**

In `extensions/local-engines.ts`, replace `manualProviderIds` and `loadManualProviderIds` with:

```typescript
type ManualProvider = Record<string, unknown> & {
  models?: Array<Record<string, unknown>>;
};

export type LocalEnginesDependencies = {
  discover?: DiscoverFn;
  loadConfig?: () => unknown;
  env?: NodeJS.ProcessEnv;
  manualProviders?: () => Map<string, ManualProvider>;
};

function loadManualProviders() {
  try {
    const parsed = JSON.parse(readFileSync(join(getPiAgentDir(), "models.json"), "utf8"));
    const providers = parsed?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return new Map<string, ManualProvider>();
    }
    return new Map(
      Object.entries(providers).filter(
        (entry): entry is [string, ManualProvider] =>
          Boolean(entry[0]) && typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
      ),
    );
  } catch {
    return new Map<string, ManualProvider>();
  }
}
```

- [ ] **Step 4: Add deterministic model normalization and merging**

Add pure helpers beside `toRegisterModels`:

```typescript
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function modelId(model: Record<string, unknown>): string | undefined {
  return typeof model.id === "string" && model.id.trim() ? model.id : undefined;
}

function mergeCompat(base: unknown, override: unknown) {
  const left = objectValue(base);
  const right = objectValue(override);
  return left || right ? { ...left, ...right } : undefined;
}

function mergeModel(
  base: Record<string, unknown> | undefined,
  manual: Record<string, unknown>,
  providerCompat: unknown,
) {
  const id = modelId(manual);
  if (!id) return undefined;
  const cost = { ...ZERO_COST, ...objectValue(base?.cost), ...objectValue(manual.cost) };
  return {
    id,
    name: typeof manual.name === "string" ? manual.name : base?.name ?? id,
    api: manual.api ?? base?.api,
    baseUrl: manual.baseUrl ?? base?.baseUrl,
    reasoning: typeof manual.reasoning === "boolean" ? manual.reasoning : base?.reasoning ?? false,
    thinkingLevelMap: manual.thinkingLevelMap ?? base?.thinkingLevelMap,
    input: Array.isArray(manual.input) ? manual.input : base?.input ?? ["text"],
    cost,
    contextWindow: manual.contextWindow ?? base?.contextWindow ?? 128000,
    maxTokens: manual.maxTokens ?? base?.maxTokens ?? 16384,
    headers: objectValue(manual.headers) ?? base?.headers,
    compat: mergeCompat(mergeCompat(base?.compat, providerCompat), manual.compat),
  };
}

function mergeRegisterModels(
  discovered: Array<Record<string, unknown>>,
  manualProvider?: ManualProvider,
) {
  const live = toRegisterModels(discovered);
  if (!manualProvider || !Array.isArray(manualProvider.models)) return live;

  const manualById = new Map<string, Record<string, unknown>>();
  const manualOrder: string[] = [];
  for (const model of manualProvider.models) {
    const record = objectValue(model);
    const id = record && modelId(record);
    if (!record || !id) continue;
    const previous = manualOrder.indexOf(id);
    if (previous >= 0) manualOrder.splice(previous, 1);
    manualOrder.push(id);
    manualById.set(id, record);
  }

  const seen = new Set<string>();
  const merged = live.map((model) => {
    const id = modelId(model)!;
    seen.add(id);
    const manual = manualById.get(id);
    return manual ? mergeModel(model, manual, manualProvider.compat)! : model;
  });
  for (const id of manualOrder) {
    if (seen.has(id)) continue;
    const model = mergeModel(undefined, manualById.get(id)!, manualProvider.compat);
    if (model) merged.push(model);
  }
  return merged;
}
```

Keep the returned nested model shape limited to Pi-supported fields. Do not spread raw provider or model objects into registration output.

- [ ] **Step 5: Register a merged overlay only when live discovery has models**

Update `registerLocalEngines`:

```typescript
const manualProviders = (dependencies.manualProviders ?? loadManualProviders)();
```

Inside the provider loop, remove the manual-provider early `continue`, then use:

```typescript
const manual = manualProviders.get(id);
const discovered = result?.ok && Array.isArray(result.models) ? result.models : [];
if (!discovered.length) {
  if (!manual) unavailable.push(id);
  continue;
}
const models = mergeRegisterModels(discovered, manual);
```

Build the provider config from manual supported fields when present:

```typescript
const firstBase = result.models[0]?.baseUrl || localEngines.ensureOpenAiV1BaseUrl(result.baseUrl);
const manualBaseUrl = typeof manual?.baseUrl === "string" ? manual.baseUrl : undefined;
const manualApiKey = typeof manual?.apiKey === "string" ? manual.apiKey : undefined;
const manualApi = typeof manual?.api === "string" ? manual.api : undefined;
const manualHeaders = objectValue(manual?.headers) as Record<string, string> | undefined;
const manualAuthHeader = typeof manual?.authHeader === "boolean" ? manual.authHeader : undefined;
const hasApiKey = Boolean(manualApiKey) || providerHasApiKey(id, env);

pi.registerProvider(id, {
  name: DISPLAY[id] || id,
  baseUrl: manualBaseUrl || firstBase,
  apiKey: manualApiKey || providerApiKey(id, env),
  api: (manualApi || "openai-completions") as "openai-completions",
  headers: manualHeaders,
  authHeader: manualAuthHeader,
  models,
  streamSimple: (model, context, options) =>
    streamOpenAiCompatible(model, context, hasApiKey ? options : {
      ...options,
      headers: { ...options?.headers, Authorization: null } as unknown as Record<string, string>,
    }),
});
```

Retain the existing per-provider `try/catch` and session-start fallback logic.

- [ ] **Step 6: Run focused unit tests**

Run:

```bash
node --test test/unit/local-engines-extension.test.mjs test/unit/local-engines.test.mjs
```

Expected: all focused local-engine unit tests pass.

- [ ] **Step 7: Commit the unit-complete behavior**

```bash
git add extensions/local-engines.ts test/unit/local-engines-extension.test.mjs
git commit -m "fix: merge manual and live Ollama models"
```

---

### Task 2: Prove merged catalogs through a real Alloy process

**Files:**
- Modify: `test/integration/local-engines.e2e.test.mjs:72-234`

**Interfaces:**
- Consumes: Task 1's startup registration behavior.
- Produces: subprocess-level proof that `alloy --list-models` exposes the merged catalog without extension/provider errors.

- [ ] **Step 1: Add a failing integration case with live and manual models**

Add a test that starts a fake Ollama server whose `/api/tags` returns `existing-live` and `new-live`, writes this temporary `models.json`, and runs Alloy:

```javascript
await writeFile(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    ollama: {
      baseUrl: `${ollama.url}/v1`,
      api: "openai-completions",
      apiKey: "ollama",
      models: [
        { id: "existing-live", name: "Manual Existing", contextWindow: 65536 },
        { id: "manual-only", name: "Manual Alias" },
      ],
    },
  },
}));

const result = await runAlloy(["--list-models"], childEnv);
assert.equal(result.code, 0, result.stderr);
assert.match(result.stdout, /ollama\s+existing-live/);
assert.match(result.stdout, /ollama\s+new-live/);
assert.match(result.stdout, /ollama\s+manual-only/);
assert.doesNotMatch(result.stderr, /Failed to load extension|Provider .* error/i);
```

Make `/api/show` return distinct context metadata for `existing-live` so the manual override can be asserted through the unit test while this integration test stays focused on actual model visibility.

- [ ] **Step 2: Run the integration test and observe the red baseline**

Run:

```bash
node --test --test-force-exit test/integration/local-engines.e2e.test.mjs
```

Expected before Task 1 implementation: FAIL because `new-live` is absent when the manual provider suppresses discovery. Expected after Task 1: PASS.

- [ ] **Step 3: Run all required verification**

```bash
node --test test/unit/local-engines.test.mjs test/unit/local-engines-extension.test.mjs
node --test --test-force-exit test/integration/local-engines.e2e.test.mjs
npm test
git diff --check
```

Expected: focused tests and the complete unit suite pass with zero failures; `git diff --check` prints nothing.

- [ ] **Step 4: Commit integration coverage**

```bash
git add test/integration/local-engines.e2e.test.mjs
git commit -m "test: cover merged Ollama catalogs end to end"
```

---

## Done When

- A live model absent from a stale manual catalog appears in `alloy --list-models`.
- Matching manual model metadata wins over discovered metadata.
- Manual-only aliases remain available.
- Manual provider transport/auth settings remain active.
- Discovery failure or disablement does not remove a manual provider.
- Focused unit and integration tests pass.
- `npm test` remains green.
- No user config, dependency, lockfile, TUI, or unrelated provider files change.
