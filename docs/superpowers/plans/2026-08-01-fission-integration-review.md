# Fission Integration Review Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the existing `/fission` feature branch works correctly on its original base, safely transplant its feature-only patch onto current GitHub `main`, and publish the verified result to `origin/main`.

**Architecture:** The remote `fission` and `main` branches have unrelated Git histories, so the integration uses the feature patch bounded by `f9441fa..origin/fission` rather than an unrelated-history merge. Existing new modules (`fission-packet`, `fission-schema`, `fission`, and `strict-json`) remain focused units; their integrations into orchestration, child policy, worktrees, configuration, help, and the extension registry are reconciled with current `main` APIs. Verification covers original-branch behavior, the transplanted branch, and the final merged `main` tree.

**Tech Stack:** Node.js 22.19+, ECMAScript modules, TypeScript Pi extensions, Node test runner, Bun/OpenTUI tests, shell release/security checks.

---

### Task 1: Establish Current-Main Baseline

**Files:**
- Inspect: `package.json`
- Inspect: `tui/package.json`
- Inspect: `.github/workflows/ci.yml`

- [ ] **Step 1: Record exact branch tips and the unrelated-history boundary**

```bash
git fetch origin main fission --prune
git rev-parse origin/main origin/fission f9441fa
test -z "$(git merge-base origin/main origin/fission)"
git log --reverse --format='%H %s' f9441fa..origin/fission
```

Expected: `origin/main` and `origin/fission` have no merge base; the bounded range contains the twelve `/fission` commits ending at `9f82960`.

- [ ] **Step 2: Install current-main dependency graphs**

```bash
git switch codex/fission-integration-review
npm ci
npm run tui:install
```

Expected: npm and Bun complete with frozen lockfiles and exit 0.

- [ ] **Step 3: Run the current-main canonical baseline**

```bash
npm run ci:local
```

Expected: unit, TUI, PTY, integration, installer, release, security, audit, and SBOM gates exit 0.

### Task 2: Verify Grok's Original Fission Tip

**Files:**
- Inspect: `lib/fission-packet.mjs`
- Inspect: `lib/fission-schema.mjs`
- Inspect: `lib/fission.mjs`
- Inspect: `extensions/fission.ts`
- Inspect: `scripts/fission-dogfood.mjs`
- Test: `test/unit/fission-*.test.mjs`
- Test: `test/unit/child-runner.test.mjs`
- Test: `test/unit/trust-boundary.test.mjs`
- Test: `test/unit/worktree.test.mjs`

- [ ] **Step 1: Check out the source tip and install its locked dependencies**

```bash
git switch --detach origin/fission
npm ci
```

Expected: checkout is detached at `9f82960` and install exits 0.

- [ ] **Step 2: Run the source branch's complete declared suite**

```bash
npm run test:all
npm run ci:local
```

Expected: all declared unit, integration, release, security, audit, and SBOM checks exit 0.

- [ ] **Step 3: Run `/fission` dogfood fixtures explicitly**

```bash
node --test test/unit/fission-dogfood.test.mjs
node scripts/fission-dogfood.mjs --manifest test/fixtures/fission-dogfood/manifest.json
```

Expected: the deterministic dogfood suite accepts control cases, detects seeded correctness/security/failure-handling defects, and exits 0.

### Task 3: Audit Security and Behavioral Contracts

**Files:**
- Review: `lib/fission-packet.mjs`
- Review: `lib/fission-schema.mjs`
- Review: `lib/fission.mjs`
- Review: `lib/strict-json.mjs`
- Review: `lib/git-state-files.mjs`
- Review: `lib/worktree.mjs`
- Review: `lib/agent-orchestration.mjs`
- Review: `lib/child-runner.mjs`
- Review: `lib/config.mjs`
- Review: `extensions/fission.ts`
- Review: `extensions/index.ts`
- Review: `lib/capabilities.mjs`
- Review: `lib/help-catalog.mjs`

- [ ] **Step 1: Trace input and trust boundaries**

```bash
rg -n "fission|strictJson|worktree|repositoryRoot|diff|review|cleanup|capabilit|sandbox|credential|abort" \
  lib/fission*.mjs lib/strict-json.mjs lib/git-state-files.mjs lib/worktree.mjs \
  lib/agent-orchestration.mjs lib/child-runner.mjs lib/config.mjs extensions/fission.ts
```

Expected: every operator input, repository path, diff-evidence path, child output, and cleanup target has a bounded validation path and fail-closed error path.

- [ ] **Step 2: Cross-check requirements against tests and documentation**

```bash
rg -n "/fission|fission" README.md docs config/alloy.example.json \
  test/unit/fission-*.test.mjs test/unit/child-runner.test.mjs \
  test/unit/trust-boundary.test.mjs test/unit/worktree.test.mjs
```

Expected: command registration, trust requirements, reviewer routing, bounded concurrency/budgets, evidence validation, cancellation, cleanup, and user-facing failure states each have test coverage and matching documentation.

### Task 4: Transplant the Feature Patch onto Current Main

**Files:**
- Create: `extensions/fission.ts`
- Create: `lib/fission-packet.mjs`
- Create: `lib/fission-schema.mjs`
- Create: `lib/fission.mjs`
- Create: `lib/strict-json.mjs`
- Create: `scripts/fission-dogfood.mjs`
- Create: `test/fixtures/fission-dogfood/**`
- Create: `test/unit/fission-dogfood.test.mjs`
- Create: `test/unit/fission-extension.test.mjs`
- Create: `test/unit/fission-packet.test.mjs`
- Create: `test/unit/fission-registration.test.mjs`
- Create: `test/unit/fission-routing.test.mjs`
- Create: `test/unit/fission-schema.test.mjs`
- Create: `test/unit/fission-workflow.test.mjs`
- Modify: `README.md`
- Modify: `config/alloy.example.json`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/BOUNDARY.md`
- Modify: `docs/MVP.md`
- Modify: `docs/SECURITY.md`
- Modify: `extensions/index.ts`
- Modify: `lib/agent-orchestration.mjs`
- Modify: `lib/agent-panel.mjs`
- Modify: `lib/capabilities.mjs`
- Modify: `lib/child-runner.mjs`
- Modify: `lib/config.mjs`
- Modify: `lib/git-state-files.mjs`
- Modify: `lib/help-catalog.mjs`
- Modify: `lib/worktree.mjs`
- Modify: `test/unit/agent-panel.test.mjs`
- Modify: `test/unit/capabilities.test.mjs`
- Modify: `test/unit/child-runner.test.mjs`
- Modify: `test/unit/help-catalog.test.mjs`
- Modify: `test/unit/trust-boundary.test.mjs`
- Modify: `test/unit/worktree.test.mjs`

- [ ] **Step 1: Apply only the bounded feature delta**

```bash
git switch codex/fission-integration-review
git diff --binary f9441fa..origin/fission -- . \
  ':!docs/superpowers/plans/2026-08-01-fission-integration-review.md' \
  | git apply --3way --index
```

Expected: new files apply directly; overlapping current-main files either merge automatically or are left as explicit conflicts.

- [ ] **Step 2: Reconcile every conflict to current-main contracts**

```bash
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<<|=======|>>>>>>>)' . -g '!node_modules' -g '!tui/node_modules'
git diff --check
```

Expected: no unmerged paths, conflict markers, whitespace errors, reverted current-main TUI behavior, downgraded dependency metadata, or stale version/package policy.

- [ ] **Step 3: Commit the reviewed transplant**

```bash
git add README.md config docs extensions lib scripts test
git commit -m "feat: add trusted fission review workflow"
```

Expected: one integration commit is based directly on current `origin/main` and contains only the reviewed `/fission` feature plus this plan.

If Tasks 2-4 expose a defect, pause this plan, invoke the systematic-debugging and test-driven-development workflows, and add a defect-specific plan task naming the exact failing test and production file before editing implementation code.

### Task 5: Verify and Publish

**Files:**
- Verify: all tracked source, tests, documentation, release metadata, and lockfiles

- [ ] **Step 1: Run focused fission and registration suites**

```bash
node --test test/unit/fission-*.test.mjs \
  test/unit/child-runner.test.mjs \
  test/unit/trust-boundary.test.mjs \
  test/unit/worktree.test.mjs \
  test/unit/help-catalog.test.mjs \
  test/unit/capabilities.test.mjs \
  test/unit/agent-panel.test.mjs
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 2: Run the full current-main release gate**

```bash
npm ci
npm run tui:install
npm run ci:local
git diff --check origin/main...HEAD
git status --short
```

Expected: every canonical gate exits 0, the diff is clean, and only intentional commits differ from `origin/main`.

- [ ] **Step 3: Re-fetch and integrate into current remote main**

```bash
git fetch origin main --prune
git switch main
git merge --ff-only origin/main
git merge --ff-only codex/fission-integration-review
npm run ci:local
```

Expected: local `main` fast-forwards from the latest remote `main`; the complete final tree passes fresh canonical verification.

- [ ] **Step 4: Push the verified main tip**

```bash
git push origin main
git ls-remote --heads origin main
```

Expected: remote `main` resolves to the verified local commit.
