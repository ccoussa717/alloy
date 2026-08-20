# SWE-bench Trusted Release Gate Design

**Date:** 2026-08-19

**Status:** Approved for implementation

## Goal

Re-enable Alloy's one-instance SWE-bench Lite release gate without allowing the
autonomous Alloy process to read benchmark answers, alter evaluator code, forge
results, or survive past its allotted attempt. A valid official `resolved` or
`unresolved` verdict will unblock a source-only Alloy `v1.1.26` release. The npm
publication boundary remains closed.

## Existing Risk

The current runner launches Alloy, captures its patch, invokes SWE-bench, and
writes results as the same host user. Disposable HOME/XDG directories and an
environment allowlist reduce ambient state but do not form a filesystem or
process boundary. An autonomous process can currently:

- Read Hugging Face caches containing private benchmark fields.
- Modify its checkout's Git metadata before patch capture.
- Replace the evaluator environment or its installed Python packages.
- Write or replace final result artifacts.
- Leave a detached process that races later patch capture or evaluation.

The real `release` command therefore remains disabled until this design is
implemented and verified.

## Chosen Architecture

Use a trusted host coordinator from a separately reviewed gate-authority commit
and isolate all candidate execution, including installation and version probes,
in locked-down disposable Docker containers. The host coordinator owns all
trusted inputs and outputs:

- Candidate snapshot and install provenance.
- Full pinned dataset row.
- Evaluator environment and Docker socket.
- Final result directory and official summary.

The agent container receives only:

- The public issue prompt.
- A writable checkout prepared at the pinned base commit.
- A read-only installed Alloy candidate.
- Disposable HOME/XDG/temp storage.
- Access to a narrow Ollama proxy on an internal Docker network.

The agent container never receives the Docker socket, host filesystem, dataset
cache, evaluator environment, coordinator source, credentials, or result path.

### Gate Authority

The candidate must not supply the code that judges its own isolation or result.
The hardening implementation is first independently reviewed and merged to
`main`. That merge SHA becomes the gate-authority commit. A separate release
metadata commit is then merged for `1.1.26` and becomes the candidate that will
be benchmarked and tagged.

The gate runs from a clean checkout of the authority commit and accepts the
candidate SHA as explicit input. It verifies that the authority is an ancestor
of the candidate and that intervening changes are restricted to the reviewed
release transformation. The permitted transformation is field- and hunk-level,
not path-level:

- Root `package.json`: only the top-level `version` string changes from
  `1.1.25` to `1.1.26`.
- `tui/package.json`: only the top-level `version` string changes likewise.
- `npm-shrinkwrap.json`: only root `version` and `packages[""].version` change.
- Enumerated runtime fallback literals: only exact `1.1.25` to `1.1.26`
  replacements at authority-recorded locations are allowed.
- `CHANGELOG.md`: the authority-recorded `[Unreleased]` entries move unchanged
  under the dated `1.1.26` heading.

Every other byte must match the authority commit. Any application logic,
benchmark, installer, dependency, workflow, policy, script, or non-enumerated
metadata change requires a new reviewed authority commit.

The coordinator, profile, dataset pins, confinement policies, proxy policy, and
evaluator lockfile all come from the authority checkout. Candidate-controlled
`install.sh`, Alloy binaries, hooks, and package scripts never execute on the
trusted host. Installation, `alloy --version`, and all other candidate probes
run inside an untrusted build container without trusted mounts or credentials.

The authority is anchored outside Git history before the release candidate
exists. A root-owned host launcher and mode-0600 configuration record the one
approved authority SHA, coordinator tree digest, confinement-policy digests,
and gate-signing public-key digest. The launcher accepts no authority override
from CLI arguments or environment variables, verifies the clean authority
checkout and every executable input before launch, and is the only supported
entry point for official evidence. Provisioning or changing that configuration
is a separate audited maintainer action, not part of a benchmark invocation.

## Common Container Boundary

Candidate install/probe, target setup, agent, Ollama proxy, and evaluator
containers all use authority-recorded images by registry digest. Every
untrusted-code container uses the authority-owned seccomp and AppArmor profiles,
non-root identity, capability drop, `no-new-privileges`, private namespaces,
resource/PID limits, timeout, inspection, and forced teardown unless a stricter
section-specific policy applies. No container receives host credentials, the
repository working tree, coordinator source, final results, or the Docker
socket. The trusted coordinator is the only Docker API client.

The proxy is trusted authority code but still runs with the same baseline and
an image digest. Post-processing uses authority code on the host without
executing exported candidate files; all file parsing is bounded and treats
content as data.

No untrusted-code container has general network access. Authority-owned fetchers
download candidate archives, package-manager artifacts, target source, and
setup dependencies before those containers start. Fetchers use exact
authority-approved origins, immutable revisions, lockfile integrity values, and
content hashes; they do not execute candidate or target lifecycle code. The
verified artifacts and read-only package caches are mounted into networkless
install/setup containers, where lifecycle steps may execute without reaching
the host gateway, private networks, metadata services, DNS, or the internet.
Integration tests attempt IPv4 and IPv6 connections to each forbidden class
from every untrusted stage.

## Agent Container Boundary

The coordinator runs the agent container with all of these controls:

- A non-root numeric UID and GID with no host-user identity dependency.
- All Linux capabilities dropped.
- `no-new-privileges` enabled.
- A repository-owned seccomp profile and named AppArmor profile whose exact
  content digests are recorded by the gate authority.
- A read-only root filesystem with explicit writable checkout and state volumes.
- A private PID namespace, an init process, a PID limit, and bounded CPU and
  memory.
- No privileged mode, host namespaces, devices, bind-mounted host paths, or
  Docker socket.
- An internal Docker network with no general outbound route.
- A fixed timeout enforced by the host coordinator.

Trusted setup loads the named AppArmor profile and verifies its loaded identity.
Preflight records supported kernel, Docker, runc, cgroup, seccomp, and AppArmor
state, then inspects the created container to prove the required profiles and
flags are active. The coordinator force-removes the container after Alloy exits
or times out and verifies that the container is gone before it reads the
checkout. Container deletion and cgroup teardown prevent detached descendants
from racing trusted post-processing.

## Ollama Access

A dedicated proxy joins both the agent's internal network and a separate
proxy-egress bridge. A trusted host relay listens on an ephemeral address bound
only to that bridge and forwards to host loopback Ollama. Host firewall rules
allow only the proxy container's fixed bridge address to reach the relay. The
relay and firewall rules are removed at teardown.

The proxy accepts only the exact HTTP methods and paths observed in the pinned
Alloy/Ollama integration test. It rejects `CONNECT`, absolute-form URLs,
redirects, alternate authorities, and request bodies naming any model other
than the pinned Ollama model. These rules are explicit test fixtures rather than
a general forwarding configuration.

Network-layer rules default-deny both IPv4 and IPv6 egress from the proxy bridge
except to the relay's exact address and port. Tests attempt direct sockets to
the host gateway, DNS, private ranges, and public addresses from both agent and
proxy networks. Startup first reconciles and removes stale gate-owned relay,
network, container, and firewall state left by a crashed prior dry-run; active
or foreign state fails closed rather than being deleted.

The agent resolves `OLLAMA_HOST` to this proxy. It cannot use the proxy to reach
GitHub, Hugging Face, package registries, host services, or arbitrary internet
destinations. Proxy logs are treated as untrusted diagnostics and do not decide
the benchmark verdict.

## Checkout Preparation And Patch Handoff

The trusted coordinator obtains the target source at the pinned base commit.
Dependency preparation and target-controlled setup scripts run in a separate
disposable setup container without host credentials or trusted mounts. The
resulting prepared tree becomes the agent's only writable work volume; the
agent attempt itself has no general outbound network.

The agent's `.git` directory and index are treated as attacker-controlled and
are never consulted after the attempt. After container teardown, the
coordinator validates before patch capture:

- The checkout is the expected volume and contains no escaping symlinks.
- Every exported entry is a permitted regular file, directory, or repository
  symlink with a safe relative target; device nodes, sockets, FIFOs, escaping
  links, and unsafe ownership or modes are rejected.
- Changed and untracked paths are relative, non-special, bounded in count and
  size, and remain inside the checkout.

The coordinator creates a fresh trusted clone at the pinned base, removes the
exported tree's untrusted `.git`, copies only validated filesystem changes into
that clone, and runs patch capture against the clone's trusted Git metadata.
This preserves staged, unstaged, untracked, and deleted changes without trusting
agent-controlled refs, indexes, hooks, attributes, or alternates. Only the
validated patch crosses into evaluation. The agent checkout volume is destroyed
after capture.

## Immutable Dataset

The benchmark profile adds:

- Hugging Face dataset revision
  `b0dde1093fe417d83b7184254edf8199c1f0dff5`.
- Test parquet SHA-256
  `438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3`.
- Canonical full-row SHA-256
  `36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153`.

Trusted setup downloads `data/test-00000-of-00001.parquet` from
`SWE-bench/SWE-bench_Lite` at that revision, verifies the parquet digest,
selects `astropy__astropy-12907`, canonicalizes the complete row, and verifies
the row digest. Canonicalization is UTF-8 encoding of Python `json.dumps` with
`sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False`, and
`allow_nan=False`, with no trailing newline. Dataset values must contain only
JSON strings, booleans, nulls, finite numbers, lists, and string-keyed objects.
The full row is stored only in trusted temporary or cache storage that is never
mounted into the agent container.

The prompt is built from a copy with `patch` and `test_patch` removed. Official
evaluation receives the verified full row through a private local JSON file.
SWE-bench 5.0.0 accepts a local JSON dataset path, so evaluation does not perform
an unpinned Hugging Face lookup.

## Immutable Evaluator

The evaluator remains trusted host release tooling. This avoids nested Docker
while keeping untrusted Alloy separated from evaluator code and result storage.

The evaluator dependency closure is captured in a dedicated lockfile containing
exact versions and SHA-256 hashes for every installed distribution. Setup uses
`pip --require-hashes`; release preflight verifies the authority-recorded
lockfile digest, Python version, SWE-bench version, and installed distribution
set before starting the agent. The selected agent base image is also referenced
by immutable registry digest rather than a mutable tag. Candidate-derived image
IDs are computed by the trusted coordinator and recorded in the run manifest.

The evaluator starts only after the agent container is destroyed and patch
capture succeeds. It receives the local verified dataset JSON and predictions
file. Evaluator scratch remains disposable; only the schema-v2 official summary
and stdout/stderr logs move into the final result directory.

The pinned instance image is
`swebench/sweb.eval.x86_64.astropy_1776_astropy-12907` at Linux/amd64 manifest
digest `sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3`.
Setup pulls that digest before the attempt, verifies the local image ID and
platform, and disables evaluator-time image pulls.

SWE-bench 5.0.0 requests `CAP_SYS_ADMIN` for every evaluation container, which
is unnecessary for this pinned Astropy instance and would let model-authored
test code cross the intended boundary. The authority carries a confinement-only
patch against a verified upstream `run_evaluation.py` hash. The patch removes
`SYS_ADMIN`, drops all capabilities, disables networking, applies the named
seccomp/AppArmor profiles and `no-new-privileges`, sets resource/PID limits, and
requires the already-pinned image digest. Setup applies the patch with no fuzz
and verifies the exact patched-file hash. Tests compare its result parsing and
command flow with unmodified SWE-bench while proving the container's effective
security settings through Docker inspection. Evaluation teardown force-removes
the container before results are accepted.

## Result Ownership

Only the trusted coordinator creates and writes the result directory. The
directory is never mounted into an agent or proxy container. Run-path pointers,
manifests, predictions, evaluator output, and the terminal summary are created
after validating regular-file and canonical-path invariants.

Terminal evidence follows cleanup-before-sign ordering. The coordinator first
proves agent and evaluator absence, then completes every registered scratch,
container, network, relay, firewall, and volume cleanup. Only after all cleanup
succeeds may it persist and sign a successful terminal manifest. A cleanup
failure can never leave a signed success: it writes a separate unsigned
`failure.json` blocking record containing the primary error and every cleanup
error. Signing failure uses the same unsigned failure path.

Agent, proxy, and evaluator logs remain untrusted content. They may be retained
for diagnosis but cannot substitute for the schema-v2 official summary.

## Failure Contract

The command fails before agent launch if any required control is absent or has
drifted, including:

- Docker daemon, AppArmor, seccomp, cgroup namespace, or required container
  flags.
- Agent image digest or candidate provenance.
- Dataset revision or row digest.
- Evaluator lockfile, installed distribution set, or SWE-bench version.
- Ollama model digest or proxy policy.

The existing terminal statuses remain attributable. Only `evaluated` with a
schema-v2 official verdict of `resolved` or `unresolved` satisfies the release
gate. Timeouts, setup failures, empty or malformed evaluator output, error
categories, and infrastructure failures block release.

The one-attempt/no-retry rule remains in force. Any additional real attempt
requires a new explicit maintainer decision and is reported separately.

A dry-run may install and probe candidate code in disposable containers but
never launches Alloy and does not consume an attempt. Before a real agent
launch, the coordinator atomically creates and verifies an attempt claim with
`O_CREAT|O_EXCL` under a mode-0700 trusted state directory outside the
repository. The claim key includes candidate commit, instance ID, dataset
revision, full-row digest, model digest, and authority/profile digest. A crash
leaves the claim in place and blocks another attempt.

Claim consumption occurs later inside `DockerRuntime.create`, after policy,
volume, daemon-identity, and create-argument validation. A one-shot callback is
invoked immediately before the Docker create subprocess with no intervening
fallible coordinator work. Callback failure issues no create request; any
Docker create failure after successful callback consumption counts as an
attempted launch and requires verified name/handle teardown evidence.

Official release evidence is accepted only from the designated release host and
includes a signed claim and result manifest using a gate-specific signing key
whose public-key digest is pinned by the root-owned host configuration and its
audited provisioning receipt before the candidate exists. Authority code
contains the signature-verification implementation but does not choose or
replace that external trust root. The private key remains in host-protected
storage and is never mounted into any container. An override is a separate
explicit CLI action requiring a maintainer-supplied reason. It mints exactly one
signed next-ordinal claim, appends an audit record, and cannot authorize a third
run without another explicit action. Runs elsewhere or without a valid signed
unconsumed ordinal may be experiments but cannot satisfy the release gate.

## Verification

Fast tests cover:

- Extended profile schema and pin validation.
- Dataset revision use and canonical row digest verification.
- Hash-locked evaluator setup and installed-distribution verification.
- Exact Docker security arguments and fail-closed preflight.
- Named seccomp/AppArmor digest and container-inspection checks.
- Internal-network and Ollama proxy policy.
- Patch validation, safe paths, Git metadata, and size bounds.
- Result ownership, official-summary validation, and terminal statuses.
- Atomic first-attempt claims, crash persistence, and audited retry overrides.
- Gate-signature validation and rejection of unsigned, wrong-host, replayed, or
  already-consumed attempt ordinals.

Focused Docker integration tests run malicious fixture agents that attempt to:

- Read host, result, evaluator, and dataset paths.
- Access the Docker socket or arbitrary internet endpoints.
- Forge evaluator or summary artifacts.
- Escape through symlinks or manipulated Git metadata.
- Leave detached background processes after exit or timeout.
- Exploit model-authored test code from inside the official evaluation image.

The tests must prove those attempts fail and that the trusted coordinator can
still capture a benign patch. Normal CI remains model-free and does not consume
the one real benchmark attempt.

Before release, the exact pushed candidate must pass:

1. Existing benchmark tests and focused Docker integration tests.
2. Full `npm run ci:local` and `npm run ci:release` verification.
3. Independent review of the exact diff.
4. Green protected-branch Linux, macOS, and aggregate CI.
5. Candidate `dry-run` from the independently pinned authority checkout with
   all integrity and isolation preflights.
6. One real benchmark attempt against that exact candidate producing a valid
   official verdict.
7. Updated `benchmarks/swebench/README.md` and `docs/RELEASING.md` that describe
   the implemented authority, container, pinning, attempt, and release flow.

## Release Sequence

The release metadata must precede the real gate so the benchmarked commit is the
commit that receives the tag:

1. Merge the independently reviewed hardening implementation to `main` and
   record that merge SHA as the gate authority.
2. In a separate release PR, bump root `package.json`, `tui/package.json`,
   `npm-shrinkwrap.json` root and
   `packages[""]`, and runtime fallback versions to `1.1.26`.
3. Move `[Unreleased]` notes into `## [1.1.26] - 2026-08-19`.
4. Merge release metadata through protected `main` with green CI. This merge SHA
   is the final candidate; intervening changes from the authority are restricted
   to the reviewed release surfaces.
5. From a clean authority checkout, run dry-run and the one real attempt against
   the final candidate SHA.
6. If the gate succeeds, tag that exact candidate as `v1.1.26` and wait for
   green tag CI.
7. Publish a source-only GitHub Release with no npm package or binary asset.
8. Inspect the source archive and confirm the stable installer resolves
   `v1.1.26`.

## Non-Goals

- Publishing Alloy to npm.
- Producing a general Alloy SWE-bench score.
- Running multiple benchmark instances.
- Making the evaluator dependency itself untrusted.
- Building a general-purpose container orchestration framework.
