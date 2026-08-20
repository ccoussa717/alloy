# SWE-bench Trusted Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Alloy's disabled same-UID SWE-bench release smoke with an independently anchored, container-isolated, integrity-pinned one-attempt gate that can safely authorize the source-only `v1.1.26` release.

**Architecture:** A root-owned launcher anchors one reviewed gate-authority commit outside candidate-controlled Git history. Authority code validates the exact release-only candidate transformation, runs every candidate-controlled stage in digest-pinned networkless containers, exposes only a narrow Ollama proxy to the agent, reconstructs the patch against trusted Git metadata, and evaluates it with a hash-locked, confinement-patched SWE-bench 5.0.0. Signed attempt claims and results are written only by the trusted coordinator.

**Tech Stack:** Python 3.12+ tests, designated-host Python 3.14.4 evaluator, Docker Engine 29.6.2, OpenSSL 3.5.5 Ed25519, AppArmor, seccomp, cgroup v2, nftables, SWE-bench 5.0.0, Hugging Face parquet, Node.js 22.19.0, Bash, Git, Ollama 0.32.13.

## Global Constraints

- Canonical GitHub repository: `https://github.com/ccoussa717/alloy.git`.
- Dataset revision: `b0dde1093fe417d83b7184254edf8199c1f0dff5`.
- Dataset parquet SHA-256: `438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3`.
- Canonical selected-row SHA-256: `36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153`.
- Instance: `astropy__astropy-12907`; base commit: `d16bfe05a744909de4b27f5875fe0d4ed41ce607`.
- Model: `qwen3.8-alloy:latest`; digest: `116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba`.
- Node toolchain image: `node:22.19.0-bookworm@sha256:f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b` on Linux/amd64.
- Python proxy image: `python:3.12.11-slim-bookworm@sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49` on Linux/amd64.
- Evaluator image: `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907@sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3`.
- The agent may call only `GET /api/tags`, `POST /api/show`, and `POST /v1/chat/completions`; model-bearing requests must name the pinned model.
- No untrusted-code container receives host credentials, trusted source, dataset gold fields, final results, arbitrary internet, or the Docker socket.
- Only an official schema-v2 `resolved` or `unresolved` verdict satisfies the release gate.
- Dry-run is non-consuming. The first real attempt is atomic and non-repeatable without a separately signed one-use retry ordinal.
- Normal CI remains model-free. No benchmark command is added to npm package metadata.
- npm publication and packaged interactive installation remain blocked.

---

### Task 1: Split And Pin The Benchmark Profile

**Files:**
- Create: `benchmarks/swebench/profile.py`
- Modify: `benchmarks/swebench/profile.json`
- Modify: `benchmarks/swebench/runner.py`
- Create: `benchmarks/swebench/tests/test_profile.py`
- Modify: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Produces: `DatasetPin`, `ImagePin`, `SecurityPolicy`, `ResourceLimits`, `ProxyPolicy`, and `BenchmarkProfile` frozen dataclasses.
- Produces: `load_profile(path: Path, authority_root: Path) -> BenchmarkProfile`.
- Consumes: authority-owned policy files added in Task 4.

- [ ] **Step 1: Write strict profile tests**

Create fixtures from the current profile and test exact keys, lowercase hashes, digest-qualified images, Linux/amd64, positive limits, fixed proxy routes, and policy-file hash mismatches. The base assertion must be:

```python
profile = load_profile(PROFILE_PATH, REPO_ROOT)
self.assertEqual(profile.dataset.revision, "b0dde1093fe417d83b7184254edf8199c1f0dff5")
self.assertEqual(profile.dataset.parquet_sha256, "438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3")
self.assertEqual(profile.dataset.row_sha256, "36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153")
self.assertEqual(profile.evaluator_image.manifest_digest, "sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3")
self.assertEqual(profile.proxy.allowed_routes, (("GET", "/api/tags"), ("POST", "/api/show"), ("POST", "/v1/chat/completions")))
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_profile -v`

Expected: import failure for `benchmarks.swebench.profile`.

- [ ] **Step 3: Implement strict dataclasses and parsing**

Use one helper for each primitive contract and reject unknown keys before construction:

```python
def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256")
    return value

def _manifest_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a sha256 image manifest digest")
    return value
```

Move profile parsing out of `runner.py`; retain imports there so existing callers migrate without duplicate schemas. Populate `profile.json` with every Global Constraints pin plus explicit limits: 1,800-second agent timeout, 2,400-second evaluator timeout, 512 PIDs, 16 GiB memory, 4 CPUs, 20,000 files, 16 MiB per file, and 256 MiB total export.

- [ ] **Step 4: Run profile and legacy runner tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_profile benchmarks.swebench.tests.test_runner.ProfileTests -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/profile.py benchmarks/swebench/profile.json benchmarks/swebench/runner.py benchmarks/swebench/tests/test_profile.py benchmarks/swebench/tests/test_runner.py
git commit -s -m "refactor: define trusted SWE-bench profile pins"
```

### Task 2: Verify The Authority And Exact Release Transformation

**Files:**
- Create: `benchmarks/swebench/authority.py`
- Create: `benchmarks/swebench/release-transform.json`
- Create: `benchmarks/swebench/host-config.example.json`
- Create: `benchmarks/swebench/tests/test_authority.py`
- Modify: `README.md`
- Modify: `docs/assets/alloy-terminal.svg`

**Interfaces:**
- Produces: `ReleaseTransformPolicy`, `VerifiedCandidate`.
- Produces: `verify_candidate(repository: Path, authority_commit: str, candidate_commit: str, policy: ReleaseTransformPolicy) -> VerifiedCandidate`.
- Produces: `coordinator_tree_digest(repository: Path, authority_commit: str, paths: tuple[str, ...]) -> str`.
- Produces: `main(argv: Sequence[str] | None = None) -> int` for read-only candidate verification.

- [ ] **Step 1: Write temporary-repository transformation tests**

Create one authority commit at `1.1.25`, then candidate commits. Accept only these semantic changes:

```python
ALLOWED_JSON_POINTERS = {
    "package.json": ("/version",),
    "tui/package.json": ("/version",),
    "npm-shrinkwrap.json": ("/version", "/packages//version"),
}
ALLOWED_LITERALS = {
    "extensions/ui.ts": 1,
    "lib/child-runner.mjs": 1,
    "lib/mcp-client.mjs": 1,
}
```

Test rejection of extra package scripts, dependencies, whitespace edits, README changes, modified benchmark code, additional version literals, non-ancestor candidates, and rewritten changelog text.

- [ ] **Step 2: Run the tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_authority -v`

Expected: import failure for `benchmarks.swebench.authority`.

- [ ] **Step 3: Implement blob-level verification**

Read blobs with `git show <sha>:<path>` without checking out or executing candidate files. Compare full tree path/mode/object tuples first, then allow only policy paths. Parse JSON and prove every value except the enumerated pointers is structurally equal. Verify exact old/new literal counts and changelog extraction into `## [1.1.26] - 2026-08-19`.

Make current-release README copy version-neutral in this authority commit so it does not need a post-authority edit. Replace the SVG's fixed version with `ALLOY` only.

- [ ] **Step 4: Run focused and release-boundary tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_authority -v && node --test test/unit/version-catalog.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/authority.py benchmarks/swebench/release-transform.json benchmarks/swebench/host-config.example.json benchmarks/swebench/tests/test_authority.py README.md docs/assets/alloy-terminal.svg
git commit -s -m "feat: verify exact SWE-bench release candidates"
```

### Task 3: Own Results And Sign Single-Use Attempts

**Files:**
- Create: `benchmarks/swebench/attempts.py`
- Create: `benchmarks/swebench/artifacts.py`
- Create: `benchmarks/swebench/tests/test_attempts.py`
- Create: `benchmarks/swebench/tests/test_artifacts.py`

**Interfaces:**
- Produces: `AttemptKey`, `SignedClaim`, `GateSigner`, `ResultWriter`.
- Produces: `claim_first_attempt(state_dir: Path, key: AttemptKey, signer: GateSigner) -> SignedClaim`.
- Produces: `authorize_retry(state_dir: Path, key: AttemptKey, reason: str, signer: GateSigner) -> SignedClaim`.
- Produces: `verify_claim(claim: SignedClaim, public_key: Path, expected_key: AttemptKey, consumed: set[int]) -> None`.

- [ ] **Step 1: Write claim, signature, replay, and path tests**

Use temporary Ed25519 keys generated with:

```bash
openssl genpkey -algorithm ED25519 -out gate-key.pem
openssl pkey -in gate-key.pem -pubout -out gate-key.pub.pem
```

Test mode-0700 state, `O_CREAT|O_EXCL`, crash persistence, canonical JSON, ordinal 1, one explicit ordinal 2 with nonempty reason, rejection of implicit ordinal 3, wrong signatures, symlinked state/results, replay, and claim consumption only at agent launch.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_attempts benchmarks.swebench.tests.test_artifacts -v`

Expected: module import failures.

- [ ] **Step 3: Implement canonical records and OpenSSL signing**

Use UTF-8 sorted compact JSON with no trailing newline as signing bytes. Call OpenSSL without a shell:

```python
subprocess.run(
    ["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key)],
    input=payload,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=True,
)
```

Create claims with directory file descriptors, `O_NOFOLLOW`, `O_CREAT|O_EXCL`, mode `0o600`, `fsync`, and atomic rename. `ResultWriter` creates one canonical run directory and exposes bounded `write_json`, `write_text`, and `copy_regular_file` methods; no agent path is accepted.

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_attempts benchmarks.swebench.tests.test_artifacts -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/attempts.py benchmarks/swebench/artifacts.py benchmarks/swebench/tests/test_attempts.py benchmarks/swebench/tests/test_artifacts.py
git commit -s -m "feat: sign single-use benchmark attempts"
```

### Task 4: Enforce Docker, Seccomp, And AppArmor Confinement

**Files:**
- Create: `benchmarks/swebench/containers.py`
- Create: `benchmarks/swebench/policies/untrusted-seccomp.json`
- Create: `benchmarks/swebench/policies/alloy-swebench-gate.apparmor`
- Create: `benchmarks/swebench/tests/test_containers.py`

**Interfaces:**
- Produces: `MountSpec`, `ContainerSpec`, `ContainerHandle`, `PreflightReport`, `DockerRuntime`.
- `DockerRuntime` methods: `preflight`, `pull_and_verify`, `create`, `inspect_security`, `wait`, `force_remove`, `assert_absent`.

- [ ] **Step 1: Write exact command and inspection tests**

Assert every untrusted container includes this baseline:

```text
--user 65532:65532 --cap-drop ALL --security-opt no-new-privileges
--security-opt seccomp=<authority path>
--security-opt apparmor=alloy-swebench-gate
--read-only --init --pids-limit 512 --memory 17179869184 --cpus 4
```

Reject mutable image tags, privileged mode, host PID/IPC/UTS/network, devices, Docker socket mounts, writable trusted mounts, missing cgroup v2, missing AppArmor, policy digest drift, non-amd64 images, and post-create inspection drift.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_containers -v`

Expected: import failure for `benchmarks.swebench.containers`.

- [ ] **Step 3: Implement the Docker CLI adapter**

Use argument arrays only. Label every resource with `alloy.swebench.gate=<run-id>`. Inspect `Config.User`, `HostConfig.CapDrop`, `HostConfig.SecurityOpt`, namespace modes, limits, mounts, image ID, and network membership before start. Teardown sends force-remove, waits for absence, and rejects name reuse with a different label.

Base seccomp on Docker's default profile but remove namespace-creation syscalls not needed by Alloy. The AppArmor profile denies `/proc/*/mem`, `/sys/**` writes, mount, ptrace, raw networking, and signal access outside the container while allowing the candidate and checkout paths.

- [ ] **Step 4: Validate policies and run tests**

Run: `python3 -m json.tool benchmarks/swebench/policies/untrusted-seccomp.json >/dev/null && python3 -m unittest benchmarks.swebench.tests.test_containers -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/containers.py benchmarks/swebench/policies benchmarks/swebench/tests/test_containers.py
git commit -s -m "feat: enforce benchmark container confinement"
```

### Task 5: Pin Dataset And Evaluator Integrity

**Files:**
- Create: `benchmarks/swebench/dataset.py`
- Create: `benchmarks/swebench/evaluator.py`
- Replace: `benchmarks/swebench/requirements.txt`
- Create: `benchmarks/swebench/requirements.in`
- Create: `benchmarks/swebench/requirements.lock`
- Create: `benchmarks/swebench/patches/swebench-5.0.0-run-evaluation.patch`
- Create: `benchmarks/swebench/tests/test_dataset.py`
- Create: `benchmarks/swebench/tests/test_evaluator.py`
- Modify: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Produces: `canonical_json_bytes(value: object) -> bytes`.
- Produces: `fetch_and_verify_instance(cache: Path, profile: BenchmarkProfile) -> dict`.
- Produces: `EvaluatorEnvironment.verify()`, `EvaluatorEnvironment.run(predictions: Path, dataset_json: Path, run_id: str) -> EvaluationResult`.

- [ ] **Step 1: Write immutable dataset tests**

Assert the exact revision URL, parquet and row hashes, 7,104-byte canonical row, rejection of NaN/non-string keys, and removal of `patch`/`test_patch` only from the prompt copy.

- [ ] **Step 2: Write evaluator lock and confinement-patch tests**

Assert `requirements.lock` contains only `name==version --hash=sha256:...` entries, installation uses `--require-hashes`, installed distributions equal the lock, upstream `run_evaluation.py` hash is verified before a no-fuzz patch, and the patched source removes `cap_add=["SYS_ADMIN"]`, requires the pinned image digest, disables network, and applies Task 4 policies and limits.

- [ ] **Step 3: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_dataset benchmarks.swebench.tests.test_evaluator -v`

Expected: module import failures.

- [ ] **Step 4: Generate and verify the transitive lock**

Use the designated host's verified `python3` 3.14.4 and `uv` only as the lock generator; the output remains pip-compatible:

```bash
printf 'swebench==5.0.0\n' > benchmarks/swebench/requirements.in
test "$(python3 --version)" = "Python 3.14.4"
uv pip compile --python "$(command -v python3)" --generate-hashes --no-emit-index-url \
  --output-file benchmarks/swebench/requirements.lock \
  benchmarks/swebench/requirements.in
python3 -m venv benchmarks/swebench/.venv
benchmarks/swebench/.venv/bin/pip install --require-hashes \
  -r benchmarks/swebench/requirements.lock
```

Record the lock SHA-256 and exact upstream/patched evaluator file hashes in `profile.json`. Keep `requirements.txt` as one comment directing setup to `requirements.lock`; executable setup must never install from it.

- [ ] **Step 5: Implement dataset and evaluator modules**

Download the parquet with authority-owned `urllib` code to a temporary regular file, hash before rename, parse one row, and write the private evaluator JSON mode `0o600`. Invoke SWE-bench with the local JSON path, one instance, one worker, and no pull. Verify the evaluator container inspection and forced teardown before reading one schema-v2 summary.

- [ ] **Step 6: Run focused and legacy verdict tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_dataset benchmarks.swebench.tests.test_evaluator benchmarks.swebench.tests.test_runner.OfficialVerdictTests -v`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/swebench/dataset.py benchmarks/swebench/evaluator.py benchmarks/swebench/requirements.in benchmarks/swebench/requirements.lock benchmarks/swebench/requirements.txt benchmarks/swebench/patches benchmarks/swebench/profile.json benchmarks/swebench/tests/test_dataset.py benchmarks/swebench/tests/test_evaluator.py benchmarks/swebench/tests/test_runner.py
git commit -s -m "feat: pin SWE-bench dataset and evaluator"
```

### Task 6: Isolate Candidate Installation And Target Setup

**Files:**
- Create: `benchmarks/swebench/install.py`
- Create: `benchmarks/swebench/fetch.py`
- Create: `benchmarks/swebench/tests/test_install.py`
- Modify: `benchmarks/swebench/tests/test_release_wrapper.py`

**Interfaces:**
- Produces: `VerifiedCandidateInstall` with image ID, Alloy/Pi versions, commit, app-volume name, and archive/cache digests.
- Produces: `ArtifactFetcher.fetch_candidate`, `fetch_npm_cache`, `fetch_target_source`.
- Produces: `install_candidate(runtime, fetched, profile) -> VerifiedCandidateInstall`.

- [ ] **Step 1: Write host-execution and network-denial tests**

Use a fake candidate whose `install.sh` writes a sentinel and probes IPv4/IPv6. Prove the sentinel can appear only in the disposable volume, never on the host, and every network probe fails. Assert no trusted path, key, result, Docker socket, dataset, or coordinator source is mounted.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_install -v`

Expected: import failure for `benchmarks.swebench.install`.

- [ ] **Step 3: Implement trusted fetch and networkless install**

The fetcher downloads the exact GitHub candidate archive and package artifacts from allowlisted HTTPS origins, verifies Git object identity plus lockfile integrity, and never executes lifecycle code. Run `install.sh`, package lifecycles, and `alloy --version` only in Task 4 containers with `--network none`; mount verified caches read-only and output volumes writable.

Use the pinned Node image manifest and prefetched Bun 1.3.14 binary at existing repository SHA-256. Parse candidate metadata on the trusted side, compare it with untrusted probe output, and freeze the installed app volume read-only before the agent stage.

Prepare the Astropy checkout inside the pinned evaluator image, which already
contains the instance's base environment. The setup stage may execute target
code but remains networkless and confined by Task 4; its output is copied to a
fresh agent work volume rather than reusing evaluator state.

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_install benchmarks.swebench.tests.test_release_wrapper -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/fetch.py benchmarks/swebench/install.py benchmarks/swebench/tests/test_install.py benchmarks/swebench/tests/test_release_wrapper.py
git commit -s -m "feat: isolate benchmark candidate installation"
```

### Task 7: Build The Narrow Ollama Proxy And Network Lifecycle

**Files:**
- Create: `benchmarks/swebench/proxy.py`
- Create: `benchmarks/swebench/proxy_server.py`
- Create: `benchmarks/swebench/tests/test_proxy.py`
- Create: `benchmarks/swebench/tests/fixtures/network_probe.py`

**Interfaces:**
- Produces: `ProxyPolicy.validate(method: str, target: str, headers: Mapping[str, str], body: bytes) -> ValidatedRequest`.
- Produces: `ProxyNetwork.start(run_id: str) -> ProxyEndpoint` and `ProxyNetwork.close() -> None`.

- [ ] **Step 1: Write HTTP parser and policy tests**

Accept only the three Global Constraints routes. Reject `CONNECT`, absolute-form targets, alternate `Host`, redirects, transfer-encoding/content-length ambiguity, headers over 32 KiB, bodies over 16 MiB, malformed JSON, and model values other than `qwen3.8-alloy:latest`.

- [ ] **Step 2: Write lifecycle and egress tests**

Mock nftables and Docker to prove default-deny IPv4/IPv6, one exact proxy-IP-to-relay-port allowance, stale labeled-state cleanup, refusal to delete active or foreign state, and cleanup on success, timeout, exception, and SIGTERM.

- [ ] **Step 3: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_proxy -v`

Expected: module import failures.

- [ ] **Step 4: Implement the standard-library proxy and network manager**

Use `http.server.ThreadingHTTPServer` with all forwarding through a fixed configured Ollama origin, disabled environment proxies, no redirect handler, streaming response byte/time bounds, and request IDs. `ProxyNetwork` creates one internal agent bridge and one default-deny proxy-egress bridge, starts the host relay on an ephemeral bridge-only address, applies nftables by atomic ruleset transaction, and registers teardown before exposing the endpoint.

- [ ] **Step 5: Run tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_proxy -v`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add benchmarks/swebench/proxy.py benchmarks/swebench/proxy_server.py benchmarks/swebench/tests/test_proxy.py benchmarks/swebench/tests/fixtures/network_probe.py
git commit -s -m "feat: restrict benchmark Ollama access"
```

### Task 8: Reconstruct Patches Without Trusting Agent Git Metadata

**Files:**
- Create: `benchmarks/swebench/checkout.py`
- Create: `benchmarks/swebench/tests/test_checkout.py`
- Modify: `benchmarks/swebench/runner.py`
- Modify: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Produces: `ExportBounds`, `ValidatedTree`.
- Produces: `validate_exported_tar(path: Path, bounds: ExportBounds) -> ValidatedTree`.
- Produces: `reconstruct_trusted_checkout(base: Path, exported: ValidatedTree, destination: Path) -> None`.
- Produces: `capture_patch(checkout: Path) -> bytes` using only the fresh trusted clone's `.git`.

- [ ] **Step 1: Write hostile archive and Git tests**

Cover staged, unstaged, untracked, binary, deleted, and symlink changes as positive cases. Reject duplicate tar names, `..`, absolute paths, `.git`, hard links, sockets, FIFOs, devices, setuid/setgid, escaping symlinks, 20,001 files, 16 MiB + 1 byte files, and 256 MiB + 1 byte totals. Verify the resulting patch applies to a second clean clone.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_checkout -v`

Expected: import failure for `benchmarks.swebench.checkout`.

- [ ] **Step 3: Implement descriptor-relative extraction and reconstruction**

Never call `tar.extractall`. Iterate members, normalize POSIX paths, reject `.git` at every depth, create files with `openat`-style directory file descriptors and `O_NOFOLLOW`, and enforce bounds while streaming. Populate a fresh trusted clone from the validated tree; remove files absent from the export; run Git with `-c core.hooksPath=/dev/null -c diff.external=` and a fixed clean environment.

- [ ] **Step 4: Remove host-mode patch capture and run tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_checkout benchmarks.swebench.tests.test_runner -v`

Expected: all tests pass and no production path reads the agent's `.git`.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/checkout.py benchmarks/swebench/runner.py benchmarks/swebench/tests/test_checkout.py benchmarks/swebench/tests/test_runner.py
git commit -s -m "feat: capture agent patches through trusted Git state"
```

### Task 9: Orchestrate Dry-Run, Real Attempt, And Terminal Evidence

**Files:**
- Create: `benchmarks/swebench/coordinator.py`
- Create: `benchmarks/swebench/tests/test_coordinator.py`
- Modify: `benchmarks/swebench/runner.py`
- Modify: `benchmarks/swebench/tests/test_runner.py`

**Interfaces:**
- Produces: `TrustedCoordinator.dry_run(candidate_commit: str) -> RunEvidence`.
- Produces: `TrustedCoordinator.release(candidate_commit: str) -> RunEvidence`.
- Consumes: Tasks 1-8 modules only; `runner.py` becomes a thin CLI/status adapter.

- [ ] **Step 1: Write phase-order and failure-mapping tests**

Use recording fakes to require this exact order:

```python
EXPECTED_RELEASE_PHASES = (
    "authority", "candidate", "integrity_preflight", "candidate_install",
    "target_setup", "attempt_claim", "proxy_start", "agent_start",
    "agent_teardown", "patch_capture", "evaluation", "evaluation_teardown",
    "sign_results", "cleanup",
)
```

Dry-run stops after `candidate_install` plus integrity preflight, creates no claim, and never starts proxy/agent/evaluator. Release cannot evaluate until agent absence and trusted patch capture are recorded. Every existing terminal status remains attributable; only official `resolved`/`unresolved` returns 0.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_coordinator -v`

Expected: import failure for `benchmarks.swebench.coordinator`.

- [ ] **Step 3: Implement fixed orchestration and cleanup stacks**

Register each cleanup before creating its resource. Remove `_allow_unsafe_execution_for_tests` from production signatures. The signed manifest includes authority/candidate commits, coordinator tree digest, host identity, attempt ordinal, dataset/image/policy/lock/model digests, container IDs and inspections, candidate versions, patch SHA-256, evaluator summary SHA-256, teardown evidence, and terminal status.

- [ ] **Step 4: Run coordinator and full Python tests**

Run: `python3 -m unittest benchmarks.swebench.tests.test_coordinator benchmarks.swebench.tests.test_runner -v && python3 -m unittest discover -s benchmarks/swebench/tests -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/swebench/coordinator.py benchmarks/swebench/runner.py benchmarks/swebench/tests/test_coordinator.py benchmarks/swebench/tests/test_runner.py
git commit -s -m "feat: orchestrate trusted SWE-bench attempts"
```

### Task 10: Provision A Root-Owned Launcher And Invert The Wrapper

**Files:**
- Create: `benchmarks/swebench/host_launcher.py`
- Create: `benchmarks/swebench/provision.py`
- Modify: `scripts/run-swebench-release-smoke.sh`
- Modify: `benchmarks/swebench/tests/test_release_wrapper.py`
- Modify: `.gitignore`

**Interfaces:**
- Root launcher location: `/usr/local/libexec/alloy-swebench-gate`.
- Root config location: `/etc/alloy/swebench-gate.json`.
- Protected state location: `/var/lib/alloy-swebench-gate`.
- Wrapper commands: `test`, `setup`, `provision`, `dry-run <candidate-sha>`, `release <candidate-sha>`, `authorize-retry <candidate-sha> <reason>`.
- Official wrapper modes execute `sudo -n /usr/local/libexec/alloy-swebench-gate`; an unavailable noninteractive sudo policy fails before candidate execution.

- [ ] **Step 1: Write launcher and wrapper inversion tests**

Prove the launcher rejects non-root-owned/writable config, dirty or wrong authority checkout, digest drift, alternate config/authority environment variables, wrong public key, and direct coordinator invocation. Prove the wrapper passes only mode and candidate SHA; it never archives candidate benchmark files or executes candidate runner/profile code.

- [ ] **Step 2: Run tests and confirm red**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper -v`

Expected: assertions fail against the current candidate-snapshot wrapper.

- [ ] **Step 3: Implement audited provisioning**

`provision.py` accepts the just-merged authority SHA once, verifies the clean canonical checkout, creates an Ed25519 gate key, writes the public key and all authority digests into root-owned config, installs a minimal launcher, installs/loads AppArmor, initializes mode-0700 state, and prints a machine-readable provisioning receipt. It refuses replacement unless invoked with a separate `--replace-authority <old-sha> <new-sha>` action.

- [ ] **Step 4: Invert the shell wrapper**

Keep `test` model-free. `setup` prepares the hash-locked evaluator and immutable caches without provisioning authority. Official modes use only `/usr/local/libexec/alloy-swebench-gate`; reject candidate SHAs not matching `[0-9a-f]{40}` and all extra arguments. `release` remains fail-closed unless provisioned config validates.

- [ ] **Step 5: Run wrapper tests and syntax checks**

Run: `python3 -m unittest benchmarks.swebench.tests.test_release_wrapper -v && bash -n scripts/run-swebench-release-smoke.sh`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add benchmarks/swebench/host_launcher.py benchmarks/swebench/provision.py benchmarks/swebench/tests/test_release_wrapper.py scripts/run-swebench-release-smoke.sh .gitignore
git commit -s -m "feat: anchor the SWE-bench gate outside candidate history"
```

### Task 11: Prove The Boundary With Malicious Docker Fixtures

**Files:**
- Create: `benchmarks/swebench/tests/test_docker_integration.py`
- Create: `benchmarks/swebench/tests/fixtures/agents/benign.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/read-host.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/forge-results.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/git-metadata.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/symlink-escape.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/detached-child.sh`
- Create: `benchmarks/swebench/tests/fixtures/agents/network-probes.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Environment gate: `ALLOY_SWEBENCH_REQUIRE_DOCKER=1` makes missing Docker/security features a failure rather than a skip.

- [ ] **Step 1: Add malicious fixtures and failing integration tests**

Each fixture writes an explicit success/failure marker inside its own checkout. Tests assert host/result/dataset/evaluator reads fail, Docker socket is absent, DNS/gateway/metadata/private/public IPv4 and IPv6 fail, summaries cannot be forged, hostile Git metadata is ignored, unsafe exports fail, detached children disappear after normal exit and timeout, and model-authored evaluator code has no network or capabilities. `benign.sh` must produce one patch that applies cleanly.

- [ ] **Step 2: Run the Docker suite and confirm red**

Run: `ALLOY_SWEBENCH_REQUIRE_DOCKER=1 python3 -m unittest benchmarks.swebench.tests.test_docker_integration -v`

Expected: failures for integration hooks not yet wired or any confinement drift.

- [ ] **Step 3: Wire real components and fix only demonstrated gaps**

Use Task 9 orchestration with fixture commands substituted before attempt claiming. Do not weaken assertions or skip supported host controls. Ensure every test cleans labeled containers, networks, volumes, firewall rules, relays, and scratch on success or failure.

- [ ] **Step 4: Run integration and full benchmark suites**

Run: `ALLOY_SWEBENCH_REQUIRE_DOCKER=1 python3 -m unittest benchmarks.swebench.tests.test_docker_integration -v && python3 -m unittest discover -s benchmarks/swebench/tests -v`

Expected: all tests pass and `docker ps -a --filter label=alloy.swebench.gate -q` prints nothing.

- [ ] **Step 5: Add the Linux CI step and commit**

Add a direct post-fast-test Linux step with the environment gate; do not add npm benchmark scripts:

```yaml
- name: Verify SWE-bench Docker isolation
  run: |
    sudo apt-get update
    sudo apt-get install -y apparmor-utils nftables
    sudo apparmor_parser -r benchmarks/swebench/policies/alloy-swebench-gate.apparmor
    sudo --preserve-env=PATH,ALLOY_SWEBENCH_REQUIRE_DOCKER \
      python3 -m unittest benchmarks.swebench.tests.test_docker_integration -v
  env:
    ALLOY_SWEBENCH_REQUIRE_DOCKER: "1"
```

```bash
git add benchmarks/swebench/tests/test_docker_integration.py benchmarks/swebench/tests/fixtures .github/workflows/ci.yml
git commit -s -m "test: verify SWE-bench container isolation"
```

### Task 12: Update Release Verification And Operator Documentation

**Files:**
- Modify: `scripts/verify-release.mjs`
- Modify: `test/unit/security-gates.test.mjs`
- Modify: `test/unit/swebench-build.test.mjs`
- Modify: `benchmarks/swebench/README.md`
- Modify: `docs/RELEASING.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Release verifier dynamically checks root/TUI/shrinkwrap and the three runtime fallback values.
- Documentation replaces disabled host-mode instructions with authority provisioning and signed one-attempt flow.

- [ ] **Step 1: Write failing release-policy tests**

Assert docs name the authority launcher/config/state paths, immutable dataset and image digests, dry-run non-consumption, signed first attempt, audited one-use retry, evaluator confinement patch, exact-candidate sequence, source-only release, and blocked npm publication. Replace tests that require the obsolete same-UID warning with assertions that host mode is absent from enabled release instructions.

- [ ] **Step 2: Run tests and confirm red**

Run: `node --test test/unit/swebench-build.test.mjs test/unit/security-gates.test.mjs`

Expected: failures against old disabled-gate documentation and static version checks.

- [ ] **Step 3: Implement dynamic version verification**

Parse JSON, extract the exact TypeScript/MJS fallback literals, require each to equal root `package.json` version, and require exactly one executable occurrence per file. Keep package publication fail-closed and benchmark tooling excluded from pack/install boundaries.

- [ ] **Step 4: Rewrite release documentation and changelog entry**

Document setup versus provisioning, authority replacement, dry-run, release, explicit retry authorization, result signature verification, artifact sensitivity, no-retry default, and the final release sequence. Add the trusted-gate implementation under `[Unreleased]`; do not create `1.1.26` yet.

- [ ] **Step 5: Run all local release checks**

Run:

```bash
node --test test/unit/swebench-build.test.mjs test/unit/security-gates.test.mjs
bash scripts/run-swebench-release-smoke.sh test
npm run ci:local
npm run ci:release
git diff --check
```

Expected: every command succeeds; `release:verify:publish` remains intentionally failing only where the existing release suite expects that failure.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-release.mjs test/unit/security-gates.test.mjs test/unit/swebench-build.test.mjs benchmarks/swebench/README.md docs/RELEASING.md CHANGELOG.md
git commit -s -m "docs: enable the trusted SWE-bench release gate"
```

### Task 13: Review, Merge, And Provision The Gate Authority

**Files:**
- No new source files expected.
- Host state created outside Git: `/usr/local/libexec/alloy-swebench-gate`, `/etc/alloy/swebench-gate.json`, `/var/lib/alloy-swebench-gate`.

**Interfaces:**
- Produces: protected authority SHA and provisioning receipt required by Task 14.

- [ ] **Step 1: Run adversarial code review**

Invoke the repository's code-review workflow against `github/main...HEAD`. Fix every blocker and rerun affected tests plus the full checks from Task 12.

- [ ] **Step 2: Push and merge through protected main**

Push a hardening PR without release metadata; this is the documented bootstrap exception needed to establish the authority before creating the exact release candidate. Require Linux, macOS, aggregate verification, Docker integration, DCO, and security checks. Record the exact squash merge SHA as `AUTHORITY_SHA`.

- [ ] **Step 3: Provision from a clean authority checkout**

Run from a clean checkout whose `HEAD` is exactly `AUTHORITY_SHA`:

```bash
sudo python3 benchmarks/swebench/provision.py provision \
  --authority-sha "$AUTHORITY_SHA" \
  --repository https://github.com/ccoussa717/alloy.git
```

Expected: receipt reports matching authority/coordinator/policy/public-key digests and no candidate attempt.

- [ ] **Step 4: Verify fail-closed launcher behavior**

Run one wrong-SHA dry-run and confirm rejection before candidate execution, then run `setup` and the authority's model-free test suite.

### Task 14: Prepare The Exact `1.1.26` Candidate

**Files:**
- Modify: `package.json`
- Modify: `tui/package.json`
- Modify: `npm-shrinkwrap.json`
- Modify: `extensions/ui.ts`
- Modify: `lib/child-runner.mjs`
- Modify: `lib/mcp-client.mjs`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: one protected-main candidate SHA whose diff from authority passes `verify_candidate`.

- [ ] **Step 1: Write the release transformation only**

Change exactly four JSON version values and the three runtime fallback literals from `1.1.25` to `1.1.26`. Move `[Unreleased]` entries unchanged under `## [1.1.26] - 2026-08-19`. Make no other byte changes.

- [ ] **Step 2: Verify the candidate locally**

Run:

```bash
npm run ci:local
npm run ci:release
bash scripts/run-swebench-release-smoke.sh test
python3 -m benchmarks.swebench.authority \
  --authority "$AUTHORITY_SHA" --candidate HEAD
```

Expected: all checks pass and the authority verifier lists only the seven approved transformations plus changelog movement.

- [ ] **Step 3: Commit, review, and merge**

```bash
git add package.json tui/package.json npm-shrinkwrap.json extensions/ui.ts lib/child-runner.mjs lib/mcp-client.mjs CHANGELOG.md
git commit -s -m "release: prepare Alloy 1.1.26"
```

Push through a release PR. Require all protected checks. Record the exact merge SHA as `CANDIDATE_SHA`.

### Task 15: Run The Gate, Tag, And Publish `v1.1.26`

**Files:**
- Generated ignored evidence under `benchmarks/swebench/results/` and protected host state only.
- No source edits permitted.

**Interfaces:**
- Consumes: `AUTHORITY_SHA`, `CANDIDATE_SHA`, protected launcher, local pinned Ollama model.
- Produces: signed official gate evidence, annotated `v1.1.26`, and source-only GitHub Release.

- [ ] **Step 1: Confirm candidate and infrastructure**

Verify `github/main == CANDIDATE_SHA`, no tracked changes, green main CI, authority verifier success, Docker/AppArmor/seccomp/cgroup preflight, evaluator/image/dataset/model pins, and no existing claim for the attempt key.

- [ ] **Step 2: Run the non-consuming dry-run**

Run: `bash scripts/run-swebench-release-smoke.sh dry-run "$CANDIDATE_SHA"`

Expected: exit 0, signed `dry_run` evidence, no attempt claim, no agent/evaluator container, and complete cleanup.

- [ ] **Step 3: Run the single real attempt once**

Run: `bash scripts/run-swebench-release-smoke.sh release "$CANDIDATE_SHA"`

Expected: exactly one signed ordinal-1 claim. Continue only if exit 0 and the verified schema-v2 summary reports `resolved` or `unresolved`. On timeout or infrastructure failure, stop without retrying or releasing.

- [ ] **Step 4: Independently verify evidence**

Verify signature, authority/candidate SHAs, attempt ordinal, all pins, patch hash, evaluator summary hash, teardown records, and absence of labeled Docker/firewall resources. Inspect logs for sensitive content before sharing.

- [ ] **Step 5: Tag the exact candidate and wait for tag CI**

```bash
git tag -a v1.1.26 "$CANDIDATE_SHA" -m "Alloy 1.1.26 - trusted SWE-bench release gate"
git push github v1.1.26
RUN_ID="$(gh run list --repo ccoussa717/alloy --workflow CI --branch v1.1.26 --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RUN_ID" --repo ccoussa717/alloy --exit-status
```

Expected: Linux, macOS, aggregate verification, dependency policy, and release metadata checks pass for `v1.1.26`.

- [ ] **Step 6: Publish the source-only GitHub Release**

```bash
gh release create v1.1.26 --repo ccoussa717/alloy \
  --title "Alloy 1.1.26" --generate-notes --verify-tag
```

Attach no npm package or binary.

- [ ] **Step 7: Verify the published archive and stable installer**

Download GitHub's source archive, verify root/TUI/shrinkwrap/fallback version alignment and absence of generated evidence/secrets, then run a disposable stable-channel install and confirm `Alloy 1.1.26`. Confirm `gh api repos/ccoussa717/alloy/releases/latest --jq .tag_name` prints `v1.1.26`.

## Dependency Order

```text
1 profile
├── 2 authority
├── 3 attempts/artifacts
└── 4 confinement
    ├── 5 dataset/evaluator
    ├── 6 install/setup
    ├── 7 proxy/network
    └── 8 checkout reconstruction
         └── 9 coordinator
              └── 10 launcher/provisioning
                   └── 11 malicious integration
                        └── 12 CI/docs
                             └── 13 authority merge/provision
                                  └── 14 final candidate
                                       └── 15 gate/tag/release
```

Tasks 2, 3, and 4 may be implemented in parallel after Task 1. Tasks 5, 6, 7, and 8 may be implemented in parallel after Task 4's interfaces stabilize. Tasks 13-15 are intentionally sequential one-way operations.
