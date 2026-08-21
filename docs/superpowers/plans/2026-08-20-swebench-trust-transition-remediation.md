# SWE-bench Trust Transition Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure no mutable or unvalidated Python byte executes across the SWE-bench root trust transition.

**Architecture:** The wrapper prints a fixed explicit-SHA bootstrap ceremony instead of elevating local code. A stdlib-only launcher validates fixed descriptor-opened trust anchors before importing authority modules, while canonical provisioning creates all state and the evaluator inside the root-owned checkout without consuming local ignored files.

**Tech Stack:** Python 3.14.4 stdlib, Bash, Git, OpenSSL Ed25519, `venv`, hash-locked binary wheels, AppArmor, descriptor-relative POSIX filesystem APIs.

## Global Constraints

- Canonical repository is exactly `https://github.com/ccoussa717/alloy.git`.
- Production paths remain `/usr/local/libexec/alloy-swebench-gate`, `/etc/alloy/swebench-gate.json`, and `/var/lib/alloy-swebench-gate`.
- Official modes remain `sudo -n /usr/local/libexec/alloy-swebench-gate` with only reviewed positional arguments.
- Production launcher invocation uses isolated Python flags `-I -E -s`.
- No production environment variable or CLI argument overrides authority, config, state, launcher, repository, evaluator, or policy paths.
- No test mutates `/etc`, `/usr/local`, or `/var/lib`.
- No local or ignored `.venv` is read or copied into authority state.

---

### Task 1: Prove The Pre-Import Launcher Boundary

**Files:**
- Modify: `benchmarks/swebench/tests/test_release_wrapper.py`
- Modify: `benchmarks/swebench/host_launcher.py`

**Interfaces:**
- Produces: stdlib-only `load_trusted_host() -> TrustedHost` before authority imports.
- Produces: `_authority_main(host, mode, candidate_commit, reason)` called only after validation.

- [ ] **Step 1: Add failing subprocess tripwire tests**

Create a temporary authority repository containing a modified `benchmarks/swebench/__init__.py` and `coordinator.py` that write a sentinel on import. Generate a test launcher by replacing only fixed compile-time path and required-UID constants, then invoke it as an executable with contaminated `PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, and `PYTHONINSPECT`. Assert unsafe environment, symlinked roots, dirty authority, wrong HEAD, tree drift, policy drift, launcher drift, and public-key drift all fail while the sentinel remains absent. Assert a valid fixture reaches the import boundary.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.HostLauncherSubprocessTests -v`

Expected: failures because authority imports occur at module import time and Python environment contamination is not rejected.

- [ ] **Step 3: Rewrite launcher phase one with stdlib only**

Use the shebang `#!/usr/bin/env -S /usr/bin/python3 -I -E -s`. Before any `benchmarks.swebench` import: require UID 0, reject every environment key beginning with `PYTHON`, install a fixed environment, validate argument arity/SHA, open fixed paths component-by-component with `O_DIRECTORY|O_NOFOLLOW`, validate owner/type/mode using `fstat`, parse exact config JSON through a bounded descriptor read, use fixed `/usr/bin/git` commands to verify clean exact checkout and fixed remote, compute the reviewed coordinator tree digest from `git ls-tree`, and hash fixed policy/key/launcher descriptors.

- [ ] **Step 4: Import only from the validated authority root**

After validation, set `sys.path[:] = [authority_root, ...stdlib paths retained by isolated Python]`, import the exact authority modules inside `_import_authority`, reconstruct strict `HostConfig`/profile objects, and invoke the coordinator. Keep all imported names local to phase two.

- [ ] **Step 5: Run focused tests GREEN**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.HostLauncherSubprocessTests -v`

Expected: all subprocess trust-transition tests pass and every rejection leaves import tripwires untouched.

### Task 2: Replace Mutable Provision Execution With A Printed Ceremony

**Files:**
- Modify: `scripts/run-swebench-release-smoke.sh`
- Modify: `benchmarks/swebench/tests/test_release_wrapper.py`

**Interfaces:**
- Produces: `provision <authority-sha>` printing one fixed operator command and exiting zero.
- Preserves: fixed sudo launcher calls for `dry-run`, `release`, and `authorize-retry`.

- [ ] **Step 1: Add failing malicious-worktree subprocess tests**

Place a local `provision.py`, `sitecustomize.py`, package `__init__.py`, and `.venv/bin/python` that each write distinct sentinels. Invoke `provision <sha>` with contaminated Python variables. Assert no sentinel exists, stdout contains the literal canonical HTTPS URL and explicit SHA, stdout contains only absolute root-owned tools and `/usr/bin/python3 -I -E -s`, and no sudo/Python/Git fixture was executed.

- [ ] **Step 2: Run wrapper tests RED**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.ReleaseWrapperTests -v`

Expected: failures because current `provision` discovers the worktree and sudo-executes local Python.

- [ ] **Step 3: Implement print-only explicit-SHA provisioning**

Change arity to `provision <authority-sha>`. Before repository discovery, validate `[0-9a-f]{40}` and print a shell-quoted fixed ceremony that creates a fresh `/var/lib/alloy-swebench-bootstrap-<sha>` with mode 0700, uses `/usr/bin/git init`, fetches the literal canonical URL and SHA, verifies `ls-remote ... refs/heads/main` equals the input, checks out detached `FETCH_HEAD`, verifies HEAD/clean status, and executes only the fetched `benchmarks/swebench/provision.py` via `/usr/bin/python3 -I -E -s`. Do not execute the printed command.

- [ ] **Step 4: Run wrapper tests GREEN and shell syntax**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.ReleaseWrapperTests -v && bash -n scripts/run-swebench-release-smoke.sh`

Expected: all pass.

### Task 3: Make Provisioning Descriptor-Relative And Build The Evaluator

**Files:**
- Modify: `benchmarks/swebench/provision.py`
- Modify: `benchmarks/swebench/tests/test_release_wrapper.py`

**Interfaces:**
- Produces: `_open_root(path: Path, expected_uid: int) -> int` for test-root injection only.
- Produces: descriptor-relative create/open/publish helpers with no-follow and fsync.
- Produces: `_build_evaluator(authority_root: Path, profile: dict[str, object], runner=..., pass_fds=...) -> None`.

- [ ] **Step 1: Add failing descriptor and evaluator tests**

Test symlinked/non-directory/group-writable/wrong-owner existing parents and destinations, file collisions, no-replace publication, fsync calls, and mode contracts under a temporary root. Add a malicious local `.venv` sentinel outside the canonical authority checkout and assert no provisioning open/command references it. Record evaluator commands and require fixed Python 3.14.4, `-m venv --copies`, `pip install --require-hashes --only-binary=:all:`, exact lock path, and approved HTTPS origins.

- [ ] **Step 2: Run provisioning tests RED**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.ProvisionTests -v`

Expected: failures because existing helpers use path traversal, chmod unsafe nodes, replace destinations, and copy local `.venv`.

- [ ] **Step 3: Implement descriptor-relative filesystem operations**

Open the trusted test/production root once. Walk each existing component with `os.open(name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW, dir_fd=fd)`, validate with `fstat`, and reject unsafe modes instead of chmod. Create missing reviewed directories with `mkdir(..., dir_fd=fd)`, reopen no-follow, and fsync parents. Create files with `O_CREAT|O_EXCL|O_NOFOLLOW`, write/fsync, and publish through collision-refusing hard-link or renameat2-no-replace semantics followed by directory fsync.

- [ ] **Step 4: Remove local prepared-environment copying**

Delete `_copy_prepared_environment`. Provisioning source is its own canonical root-owned checkout; no caller supplies a repository, config, authority, evaluator, or policy path. Keep only explicit initial authority SHA or explicit old/new replacement action.

- [ ] **Step 5: Build and verify evaluator in authority state**

Require `/usr/bin/python3.14 --version` to equal `Python 3.14.4`. Create the venv under authority state, remove/reject aliases, install exact binary wheels with hashes and approved indexes, run a stdlib metadata probe to compare the complete normalized distribution set with `requirements.lock`, verify upstream `run_evaluation.py`, apply `/usr/bin/patch --batch --forward --fuzz=0 --strip=1`, and verify the patched hash before config publication.

- [ ] **Step 6: Run provisioning tests GREEN**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper.ProvisionTests -v`

Expected: all pass without touching live system paths.

### Task 4: Integrate, Review, Report, And Commit

**Files:**
- Modify: `.superpowers/sdd/task-10-report.md` (ignored report)
- Verify all Task 10 files and docs.

- [ ] **Step 1: Run focused and full verification**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper -v && bash -n scripts/run-swebench-release-smoke.sh`

Run: `python3 -m unittest discover -s benchmarks/swebench/tests -v`

Run: `python3 -m py_compile benchmarks/swebench/host_launcher.py benchmarks/swebench/provision.py benchmarks/swebench/coordinator.py && git diff --check`

Expected: all focused/full/static gates pass; only documented opt-in integration skips remain.

- [ ] **Step 2: Review the complete diff adversarially**

Check pre-import statements mechanically, inspect subprocess argv, verify no local provisioning/evaluator path is reachable, and ensure every filesystem mutation is rooted in validated dirfds. Fix every must-fix finding and rerun Step 1.

- [ ] **Step 3: Append the Task 10 report**

Record RED/GREEN evidence, exact test counts, trust-boundary decisions, independent-review result, and remaining live-root integration concerns in `.superpowers/sdd/task-10-report.md`.

- [ ] **Step 4: Create the DCO-signed remediation commit**

```bash
git add benchmarks/swebench/host_launcher.py benchmarks/swebench/provision.py benchmarks/swebench/tests/test_release_wrapper.py scripts/run-swebench-release-smoke.sh docs/superpowers/plans/2026-08-20-swebench-trust-transition-remediation.md
git commit -s -m "fix: close SWE-bench trust transition gaps"
```

Do not push.
