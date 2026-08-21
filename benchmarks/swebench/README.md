# SWE-bench Release Smoke

This maintainer-only gate runs one pinned SWE-bench Lite instance against an
exact Alloy release candidate. It is a one-instance smoke, not an Alloy
SWE-bench score, and it is not an end-user command or dependency.

## Trust Anchors

The official gate runs from root-owned authority installed before the release
candidate exists:

- Launcher: `/usr/local/libexec/alloy-swebench-gate`
- Configuration: `/etc/alloy/swebench-gate.json`
- Protected authority, signing keys, attempts, work, and results:
  `/var/lib/alloy-swebench-gate`

`bash scripts/run-swebench-release-smoke.sh provision <authority-sha>` prints an
operator-reviewed bootstrap command. It does not execute worktree Python or
invoke `sudo`. Save and inspect the printed ceremony, then execute it only for
the full lowercase SHA of the just-merged canonical `main` tip:

```bash
AUTHORITY_SHA=<40-character-main-sha>
bash scripts/run-swebench-release-smoke.sh provision "$AUTHORITY_SHA" \
  > /tmp/alloy-swebench-bootstrap.sh
less /tmp/alloy-swebench-bootstrap.sh
/bin/sh /tmp/alloy-swebench-bootstrap.sh
rm -f /tmp/alloy-swebench-bootstrap.sh
```

The ceremony fetches that SHA from the hardcoded canonical HTTPS repository in
a fresh root-owned mode-0700 directory. Provisioning generates an Ed25519 gate
key, builds the hash-locked evaluator with root Python 3.14.4, installs and loads
the confinement policy, and emits a JSON receipt. Preserve and audit that
receipt. It creates the fixed launcher, config, and protected state paths above.
It never copies the unprivileged `.venv` prepared by `setup`.

Provisioning is one-time and refuses implicit replacement. An authority update
is a separate audited operation from a freshly fetched canonical root-owned
checkout of the new `main` tip:

```bash
sudo /usr/bin/env -i \
  HOME=<empty-root-owned-mode-0700-git-home> PATH=/usr/bin:/bin \
  /usr/bin/python3 -I -E -s \
  <fresh-root-owned-new-authority-checkout>/benchmarks/swebench/provision.py \
  --replace-authority <old-sha> <new-sha>
```

The empty Git HOME and checkout must use the same root ownership, mode, canonical
remote, clean-tree, and exact-main-tip checks as initial bootstrap. Verify both
SHAs and the replacement receipt before running another candidate. Replacement
preserves the gate key and protected attempt history; it cannot silently reset
the no-retry policy.

## Immutable Inputs

The authority profile pins all release inputs:

- Dataset revision: `b0dde1093fe417d83b7184254edf8199c1f0dff5`
- Dataset parquet SHA-256:
  `438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3`
- Selected row SHA-256:
  `36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153`
- Agent image manifest digest:
  `sha256:f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b`
- Proxy image manifest digest:
  `sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49`
- Evaluator image manifest digest:
  `sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3`
- Ollama model digest:
  `116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba`
- Evaluator confinement patch SHA-256:
  `3f2d38f9b0363fcc814ba97f8a8c18fc7e46c665e5e5e3b29a70902bc08c54f6`

The evaluator dependency closure is fully exact in `requirements.lock`, with
hashes for every distribution and bootstrap `pip`. Provisioning verifies the
lock digest, installed distribution set, upstream evaluator source hash, and the
patched evaluator hash. The confinement patch removes `CAP_SYS_ADMIN`, disables
networking, drops capabilities, and applies the pinned AppArmor and seccomp
policies. Runtime verification never resolves or upgrades evaluator packages.

## Prerequisites

- Python 3.11 or newer for fast tests. CI uses Python 3.12.
- Root Python 3.14.4 and binary wheels for authority provisioning.
- A reachable, functioning Docker daemon with AppArmor, seccomp, cgroup, and
  internal-network controls available. An installed Docker CLI is insufficient.
- A local Ollama service on loopback with `qwen3.8-alloy:latest` at the pinned
  digest above.
- Outbound GitHub and codeload access for authority and candidate verification.
- Target repository clone access.
- Hugging Face dataset access during setup/provisioning.
- Image and registry access required by SWE-bench.

## Setup And Tests

`setup` is unprivileged convenience setup. It prepares local caches and the
source-only benchmark environment but does not provision authority and is not
consumed by the official root gate:

```bash
bash scripts/run-swebench-release-smoke.sh setup
```

Run the complete model-free benchmark suite with:

```bash
bash scripts/run-swebench-release-smoke.sh test
```

The tests validate provenance, immutable pins, authority loading, attempt
claims, cleanup ordering, artifact ownership, and container isolation fixtures.
They do not run a model or consume the real release attempt.

All benchmark commands are source-only wrapper subcommands. Root and packed
`package.json` metadata contain no benchmark command. `benchmarks/` and
`scripts/run-swebench-release-smoke.sh` are excluded from `npm pack` and removed
by the source installer after source validation. npm publication is blocked.
The supported release is a source-only GitHub release.

## Exact Candidate Flow

After the release metadata PR has merged with green CI, record the exact pushed
candidate SHA. It must be the full lowercase commit advertised specifically as
`refs/heads/main` by the canonical GitHub remote; another branch or tag pointing
to the same commit is insufficient. The root-owned authority fetches that exact
ref and verifies that the candidate differs from the authority only by the
reviewed root/TUI/shrinkwrap version fields, three runtime fallback literals,
and changelog extraction.

Run the candidate dry-run first:

```bash
CANDIDATE_SHA=<40-character-release-candidate-sha>
bash scripts/run-swebench-release-smoke.sh dry-run "$CANDIDATE_SHA"
```

The wrapper delegates with noninteractive sudo to the fixed root launcher. The
dry-run validates authority, candidate, package installation, dataset, image,
model, evaluator, and confinement provenance in disposable containers. A
dry-run does not consume an attempt, does not launch Alloy, and cannot satisfy
the release gate.

After independent review of the dry-run evidence and explicit maintainer
authorization, start the signed first attempt exactly once:

```bash
bash scripts/run-swebench-release-smoke.sh release "$CANDIDATE_SHA"
```

The coordinator creates a signed first-attempt claim keyed to the candidate,
instance, dataset revision and row, model, and authority profile. It consumes
that claim immediately before the one Docker create request. There is no
automatic retry. A crash, timeout, Docker create failure after consumption,
`unresolved` verdict, or infrastructure failure does not make another launch
available.

Only a new explicit maintainer decision may create the audited, one-use retry:

```bash
bash scripts/run-swebench-release-smoke.sh authorize-retry "$CANDIDATE_SHA" \
  "<specific audited infrastructure reason>"
bash scripts/run-swebench-release-smoke.sh release "$CANDIDATE_SHA"
```

The retry command emits the signed ordinal-2 claim. It cannot authorize an
implicit third attempt, and its reason and separate result must remain in the
release audit record.

## Results And Signatures

Results are root-owned beneath `/var/lib/alloy-swebench-gate/results/`. The
trusted coordinator is their only writer; result storage, evaluator code, the
dataset gold fields, signing keys, and the Docker socket are never mounted into
the agent container. The runner does not intentionally inject host credentials
or environment variables, dataset gold fields, or evaluator scripts into
persisted artifacts.

Terminal evidence uses cleanup-before-sign ordering. The coordinator proves the
agent and evaluator absent and cleans every scratch directory, container,
network, relay, firewall rule, and volume before writing `manifest.json` and
`manifest.signature.json`. Any cleanup or signing uncertainty writes unsigned
`failure.json` and blocks release; it cannot leave signed success evidence.

Verify `manifest.signature.json` says `Ed25519`, verify its signature over the
canonical bytes of `manifest.json` with the provisioned public key, and verify
that public key's SHA-256 equals `gate_public_key_sha256` in
`/etc/alloy/swebench-gate.json` and the provisioning receipt. Then inspect the
signed authority/candidate commits, attempt ordinal, all input digests,
validated kernel/runc preflight evidence, container inspections, cleanup proof,
terminal status, patch digest, and evaluator-summary digest.

Agent/evaluator stdout/stderr, model patches, and official summaries are
untrusted and may contain sensitive content produced or read by those
processes. Maintainers must inspect persisted artifacts before sharing,
attaching, or releasing them. A valid signature proves gate origin and
integrity, not that untrusted artifact content is safe to disclose.

## Verdicts

`resolved` and `unresolved` are both valid official one-instance outcomes.
Only a persisted schema-v2 official summary can complete the execution gate.
`infrastructure_failure` means no valid official verdict exists and blocks gate
completion. Logs, an exit code, or human interpretation cannot replace the
official summary. This one result must never be presented as an Alloy SWE-bench
score.

After valid signed evidence is independently reviewed, tag the exact candidate,
wait for green tag CI, and publish only the source-only GitHub release. Do not
publish or attach an npm package or binary artifact.
