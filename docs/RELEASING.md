# Releasing Alloy

Only maintainers may publish a release. Alloy ships continuously as tagged,
source-only GitHub releases; npm publication is blocked.

## Continuous Stable Shipping

Every meaningful ship that lands on `main` gets an appropriate semver tag and
GitHub Release so the stable installer resolves the newest line:

```bash
curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/main/install.sh | bash
```

Use a patch for fixes, documentation that changes operator behavior, small UX
changes, and security updates. Use a minor for new workflow capability or
behavior/config changes, and a major for breaking changes. Skip a tag only for a
truly invisible internal refactor.

## Release Checklist

1. Merge the independently reviewed gate hardening to protected `main`; record
   that pushed merge SHA as the authority.
2. Provision that authority on the designated release host and preserve its
   machine-readable receipt. If authority was previously provisioned, use the
   explicit replacement procedure below.
3. In a separate release PR, bump root `package.json`, `tui/package.json`, both
   root versions in `npm-shrinkwrap.json`, and all three runtime fallback
   versions. Move `[Unreleased]` into a dated release section.
4. Run `npm run ci:local`, `npm run ci:release`, independent review, and protected
   branch CI. Merge only the reviewed release surfaces. Record that pushed merge
   SHA as the exact candidate.
5. Run the manual SWE-bench release gate against that exact candidate: dry-run,
   explicit authorization, and one real attempt. Verify the signed result and
   inspect sensitive artifacts.
6. Tag that exact candidate commit and wait for green tag CI.
7. Publish a source-only GitHub release with no npm package or binary asset.
8. Inspect the published source archive and confirm the stable installer
   resolves the new tag.

Do not bump or tag a different commit after the benchmark. Any intervening
source change creates a new candidate and invalidates the evidence.

## Manual SWE-bench Release Gate

The official gate runs from independently provisioned, root-owned authority:

- `/usr/local/libexec/alloy-swebench-gate`: fixed launcher used by official modes
- `/etc/alloy/swebench-gate.json`: authority, policy, coordinator-tree, and gate
  public-key digests
- `/var/lib/alloy-swebench-gate`: authority checkout, key material, claims, work,
  and results

Read the complete [SWE-bench release smoke instructions](../benchmarks/swebench/README.md)
before operating the gate.

### Setup Versus Provisioning

The source-only setup command prepares an unprivileged test environment and
caches. It does not establish release authority and its `.venv` is not consumed
by the official gate:

```bash
bash scripts/run-swebench-release-smoke.sh test
bash scripts/run-swebench-release-smoke.sh setup
```

Initial provisioning is a separate reviewed ceremony. The wrapper command
`provision <authority-sha>` prints, but does not execute, a canonical root
bootstrap:

```bash
AUTHORITY_SHA=<40-character-main-sha>
bash scripts/run-swebench-release-smoke.sh provision "$AUTHORITY_SHA" \
  > /tmp/alloy-swebench-bootstrap.sh
less /tmp/alloy-swebench-bootstrap.sh
/bin/sh /tmp/alloy-swebench-bootstrap.sh
rm -f /tmp/alloy-swebench-bootstrap.sh
```

The bootstrap fetches the explicit SHA directly from canonical GitHub, proves it
is the current `main` tip, runs isolated Python, builds the exact evaluator, loads
AppArmor, generates the Ed25519 gate key, and emits a receipt. Preserve that
receipt with the release audit.

Provisioning refuses an existing authority. Replacement is an explicit audited
operation from a freshly fetched canonical root-owned checkout of the new tip:

```bash
sudo /usr/bin/env -i \
  HOME=<empty-root-owned-mode-0700-git-home> PATH=/usr/bin:/bin \
  /usr/bin/python3 -I -E -s \
  <fresh-root-owned-new-authority-checkout>/benchmarks/swebench/provision.py \
  --replace-authority <old-sha> <new-sha>
```

The empty Git HOME and checkout must satisfy the initial bootstrap's root
ownership, mode, canonical remote, clean-tree, and exact-main-tip checks. Review
the old and new SHAs and receipt. Replacement preserves the private gate key and
protected attempt history.

### Pinned Inputs

Before the candidate exists, authority fixes these release inputs:

- Dataset revision `b0dde1093fe417d83b7184254edf8199c1f0dff5`
- Dataset parquet SHA-256
  `438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3`
- Selected row SHA-256
  `36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153`
- Agent image digest
  `sha256:f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b`
- Proxy image digest
  `sha256:c00fc7b44d844b6da22861ec24af43968a5200eac4ec607b4725d585165d6b49`
- Evaluator image digest
  `sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3`
- Evaluator confinement patch SHA-256
  `3f2d38f9b0363fcc814ba97f8a8c18fc7e46c665e5e5e3b29a70902bc08c54f6`

The gate also verifies the exact model digest, Python 3.14.4 evaluator closure,
requirements lock, patched evaluator source, seccomp/AppArmor policies, Docker
daemon identity, and required container controls. Confirm outbound GitHub and
codeload access, target repository clone access, Hugging Face dataset access,
Python package index access, image and registry access required by SWE-bench, a
reachable functioning Docker daemon, and the documented loopback Ollama model.

### Exact Candidate Attempt

The candidate must be the full lowercase commit SHA advertised specifically as
canonical GitHub's `refs/heads/main`; another branch or tag at that SHA is not
release evidence. The authority fetches that exact ref. The candidate may differ
from authority only on the reviewed release metadata surfaces.

```bash
CANDIDATE_SHA=<40-character-release-candidate-sha>
bash scripts/run-swebench-release-smoke.sh dry-run "$CANDIDATE_SHA"
```

The dry-run verifies the candidate install and every authority/input boundary in
disposable containers. The dry-run does not consume an attempt, does not launch
Alloy, and does not satisfy the execution gate.

After independent evidence review and explicit maintainer authorization, run the
signed first attempt once:

```bash
bash scripts/run-swebench-release-smoke.sh release "$CANDIDATE_SHA"
```

There is no automatic retry. The signed first-attempt claim is consumed
immediately before Docker create. A timeout, crash, create failure after
consumption, `unresolved`, or infrastructure failure remains consumed. Do not
turn it into an undocumented retry.

Only an explicit new maintainer decision for a specific infrastructure reason
may mint the audited, one-use retry claim:

```bash
bash scripts/run-swebench-release-smoke.sh authorize-retry "$CANDIDATE_SHA" \
  "<specific audited infrastructure reason>"
bash scripts/run-swebench-release-smoke.sh release "$CANDIDATE_SHA"
```

The ordinal-2 authorization cannot silently create a third attempt. Preserve the
reason, signed claim, and separate result in the release audit.

### Evidence And Verdicts

Terminal evidence follows cleanup-before-sign ordering. The trusted coordinator
proves agent and evaluator absence and removes every registered scratch,
container, network, relay, firewall, and volume resource before persisting
`manifest.json` and `manifest.signature.json`. Cleanup or signing uncertainty
writes only unsigned `failure.json` and blocks release.

Verify the Ed25519 signature over canonical `manifest.json` bytes with the
provisioned public key. Verify that key's SHA-256 against both
`gate_public_key_sha256` in `/etc/alloy/swebench-gate.json` and the provisioning
receipt. Confirm the signed authority and candidate commits, attempt ordinal,
input digests, validated kernel/runc preflight evidence, container inspection
and teardown proof, patch digest, evaluator summary digest, and terminal status.

`resolved` is a valid official one-instance outcome. `unresolved` is a valid
official one-instance outcome. Only a persisted schema-v2 official summary can
complete the gate. `infrastructure_failure` means no valid official verdict
exists. `infrastructure_failure` blocks gate completion. None of these outcomes
is an Alloy SWE-bench score.

The runner does not intentionally inject host credentials or environment
variables, dataset gold fields, or evaluator scripts into persisted artifacts.
Agent/evaluator stdout/stderr, model patches, and official summaries are
untrusted and may contain sensitive content produced or read by those
processes. Maintainers must inspect persisted artifacts before sharing,
attaching, or releasing them. Signature validity does not make untrusted content
safe to disclose.

## Tag And Publish

Only after the exact candidate has green CI and valid independently reviewed
gate evidence:

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "Alloy $VERSION"
git push origin "v$VERSION"
gh release create "v$VERSION" --title "Alloy $VERSION" --generate-notes
```

Wait for green tag CI before creating the GitHub Release. Publish only the
source-only GitHub release and verify `releases/latest` plus a clean installer
run at that tag.

Tip-of-tree remains developer-only:

```bash
curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/main/install.sh \
  | ALLOY_CHANNEL=main bash
```

## Public Source Launch

Making the canonical GitHub repository public is separate from publishing an
npm package. A public source pre-release may launch while `package.json` remains
private and the npm gate remains closed.

Before changing visibility, require clean pushed green `main`; verify the public
history boundary; run `npm run ci:local`, `npm run release:verify:source`, SBOM
review, and tracked-tree/release-worktree/full-history secret scans; review all
canonical identity and community files; and obtain explicit authorization. Do
not create a tag or package artifact as part of the visibility change.

Immediately after public launch, enable private vulnerability reporting, protect
`main` with required CI and review/CODEOWNERS rules, reconfirm read-only workflow
permissions and DCO enforcement, clone and test without existing credentials,
and rerun hosted CI against the exact public commit.

## Package Publication Is Blocked

The supported distribution is the source installer. `package.json` remains
private, `prepublishOnly` exits nonzero, and `release:verify:publish`
intentionally fails. `npm pack` is used only to verify the package file boundary
and bundled Pi runtime; it is not a supported installation or release artifact.

Do not publish or attach an npm package, standalone binary, or trusted-publishing
workflow. Reopening npm requires a separately designed and approved Bun package
lifecycle, clean Linux and macOS verification, updated fail-closed metadata and
tests, exact root/TUI lock review, `npm run ci:release`, and independent review.
Publishing, visibility changes, tags, and announcements require explicit
maintainer authorization.
