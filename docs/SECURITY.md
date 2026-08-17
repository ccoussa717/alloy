# Alloy security model

This document defines Alloy's security boundary and release requirements. It
is a living contract, not a dated audit sign-off.

## Scope and assets

| Asset | Location | Sensitivity |
|---|---|---|
| Pi authentication | `~/.pi/agent/auth.json` | High |
| Provider API keys | Process environment | High |
| Alloy configuration | `~/.pi/alloy/config.json` | Medium |
| MCP configuration | Global or trusted-project config | Medium to high |
| Durable memory | `~/.pi/alloy/memory/` | Medium |
| Child run artifacts | `~/.pi/alloy/runs/` | Medium |
| Checkpoints and worktrees | Git plus `~/.pi/alloy/` | Code integrity |

Alloy is a single-operator local coding harness. It is not a multi-tenant
security boundary.

## Threat model

Alloy defends against:

1. A malicious project attempting to weaken operator policy or load tools.
2. Prompt injection attempting to elevate child agents or exfiltrate secrets.
3. A buggy or runaway child exceeding the parent's permission ceiling.
4. Unsafe checkpoint or worktree paths that escape repository boundaries.
5. Compromised dependencies, installers, MCP servers, or release artifacts.

Same-user malware is outside Alloy's host-mode boundary. Use operating-system
isolation and Docker for stronger containment.

## Control matrix

| Threat | Control | Verification |
|---|---|---|
| Project config weakens policy | Global policy ceiling; project config may only tighten | trust and capability tests |
| Plan or review mutates | Central capability gate denies mutation and bash | `capabilities.test.mjs` |
| MCP bypasses policy | Native and MCP tools share the same gate | MCP and policy tests |
| Child exceeds parent | Mechanical child policy manifest and enforcer | child-policy tests |
| Required sandbox falls back to host | Docker path fails closed | Docker integration test |
| Child inherits broad credentials | Provider keys stripped from env; isolated home; Fusion leases only the selected provider | child-runner and credential-broker tests |
| Checkpoint path escape or clobber | Authenticated anchors, containment checks, collision preflight | checkpoint tests |
| Worktree escapes managed root | Canonical containment and hardened removal | worktree tests |
| Doctor leaks credentials | Pi-backed resolution with redacted status only; never values | provider tests |
| Release installs different code | Exact dependencies, release-included shrinkwrap, packed-artifact test, npm provenance | GitHub Actions |
| Secret enters source or history | Full-tree and full-history signature gate | security CI |
| Fission reads a hostile repository | Operator trust prerequisite; hostile repositories are outside the product boundary | Fission trust and packet tests |
| Fission child escapes review evidence | Read-only tools confined to the immutable packet root | Fission workflow tests |
| Fission route silently changes | Exact-route admission plus observed provider/model attestation; no fallback | Fission routing tests |
| Fission output evades bounds | Complete serialized assistant-message output limit before parsing or retention | child-runner and Fission tests |

Fusion's provider lease is resolved through Pi at child launch, then passed to
the isolated child as a static, provider-scoped credential. The child does not
receive the parent's OAuth refresh token or credential store, so a token that
expires during a routed child run is not refreshed inside that child.

## Credentials

Pi owns interactive provider authentication. Alloy does not copy the host's Pi
authentication into child homes by default. Child processes receive an
allowlisted environment with known provider credential variables removed.

Fusion is the narrow exception to credential-free child homes. For each role,
Alloy selects only the provider entry required by that configured model and
writes it to the child's ephemeral `auth.json` with mode `0600`. Environment-key
references must resolve before a lease is valid. The broker payload stays in
memory until child provisioning and must not be logged, prompted, or persisted
in Fusion artifacts. Fusion policy manifests mechanically confine `read`,
`grep`, `find`, and `ls` to the canonical repository root, including realpath
checks that block symlink escapes, so model tools cannot read the lease or host
credential paths.

Remote MCP headers can expand environment variables from `~/.pi/alloy/env`.
That file must be a regular file owned by the current user with mode `0600` and
must not be a symlink. Every non-loopback remote MCP transport requires HTTPS;
plaintext HTTP is limited to loopback development. Remote URL query parameters
are rejected unless the reviewed server configuration sets `allowQuery: true`.
Query parameters must contain routing metadata only, never credentials or other
secrets. URL fragments and embedded credentials are always rejected.

MCP stdio servers run as host processes. Configure them as deliberately as any
other executable. Published examples never execute floating npm packages.

Diagnostics run repository-defined typecheck, lint, and test commands as host
processes. Their child environment is allowlisted and excludes provider keys and
arbitrary host variables. The model-callable diagnostics tool requires approval
under the default profile, but the commands still have the operator's same-user
filesystem and network access and do not run through the Docker Bash sandbox.
`/auto` fails closed before launching agents when sandbox isolation is required.

## Fission trusted-repository boundary

Fission is for projects the operator has marked trusted. Repository Git
config/attributes may execute under normal Git behavior. Do not run it on
hostile/untrusted repositories. This is an explicit product boundary, not a
hidden implementation caveat or a claim that repository capture is inert.

The workflow limits model-visible evidence rather than making the repository
hostile-safe. Children can read only the accepted packet root, exact requested
routes must attest their actual identities, and complete assistant payloads are
bounded. Source and packet drift checks fail closed before judgment and verdict.
These controls do not defend against arbitrary same-UID host access, a malicious
Git configuration already trusted by the operator, or a byte-identical ABA
change that restores accepted bytes between checks.

Fission rejects capture beyond 16 KiB request text, 1 MiB Git status, 2 MiB
combined staged and unstaged patches, 256 KiB per retained file, 2 MiB across
all retained files, or 10,000 changed entries. Each reviewer and Judge also has
a 256 KiB cumulative serialized completed-assistant output limit. No accepted
evidence or assistant payload is silently truncated.

`PASS` means only `no submitted blocking finding validated.` It is not a test,
correctness, merge, or deployment guarantee. `NO_CHANGES` creates no review run;
all incomplete evidence, identity, cost, adjudication, and drift paths are
`INCOMPLETE`.

## Host and Docker claims

| Claim | Host child | Docker child |
|---|---|---|
| Provider keys absent from child env | Yes | Yes |
| Host Pi auth copied by default | No | No |
| Fusion selected-provider lease | Ephemeral child `auth.json` only | Ephemeral child `auth.json` only |
| Arbitrary same-user host paths blocked | No | Yes, outside mounts |
| Network blocked by default | No | Yes |
| Linux capabilities dropped | No | Yes |
| Fails closed when Docker is required but absent | N/A | Yes |

Host mode must never be described as filesystem isolation.

## Supply chain and releases

- Direct executable dependencies use exact versions. The Alloy Pi coding-agent
  fork uses one explicitly approved GitHub release URL plus matching SHA-256 and
  npm SHA-512 integrity metadata.
- Release artifacts include `npm-shrinkwrap.json`, and every registry or approved
  fork artifact must carry an integrity hash.
- Release verification resolves the fork release tag to the declared full commit,
  downloads the artifact, and checks both its SHA-256 and npm SHA-512 digests.
  GitHub release URLs can be replaced by maintainers, but replacement bytes fail
  closed against both recorded hashes.
- npm does not import a dependency tarball's nested shrinkwrap into the consuming
  project. Alloy's root shrinkwrap is therefore the authority for source-checkout
  and source-installer graphs, including Pi transitive dependencies. It does not
  guarantee the graph a future npm consumer would resolve from Alloy's tarball;
  npm publication remains blocked until that graph is independently reproducible.
  Pi fork upgrades require an explicit lock-diff audit and the full compatibility,
  packed-install, source-installer, and PTY gates described in
  [PI_FORK.md](./PI_FORK.md).
- GitHub Actions installs and starts the actual packed npm artifact.
- High and critical dependency findings block tagged release artifacts and npm
  packages. Moderate findings must be reviewed and documented when no compatible
  fix exists. A public source snapshot requires an explicit, documented
  reachability and residual-risk decision; it does not waive the artifact gate.
- GitHub Actions generates a CycloneDX SBOM for each release candidate.
- npm publication requires provenance.
- The convenience installer is fetched from mutable `main`, then resolves the
  latest stable GitHub release tag by default. `ALLOY_CHANNEL=main` selects the
  tip of `main`; `ALLOY_REF` pins an explicit tag or commit. It checksum-verifies
  any downloaded Node.js runtime, and npm verifies the shrinkwrapped dependency
  integrities. Review the installer before piping it or pin both the raw
  installer URL and `ALLOY_REF` to the same full commit SHA when the script and
  source must be immutable together. This remains a source distribution, not an
  npm package.
- Docker and CI images should be pinned to reviewed release versions. Digest
  pinning remains preferred where the hosting platform supports maintenance of
  those pins.

## Residual risks

- Host children run as the operator's user and are not filesystem-isolated.
- MCP servers are trusted host executables.
- Checkpoint restore cannot prevent all concurrent writes from external
  processes.
- Some transitive moderate advisories may remain until upstream packages ship
  compatible fixes.
- The current MCP dependency chain carries `GHSA-frvp-7c67-39w9`, a moderate
  Windows encoded-backslash path-traversal advisory in `@hono/node-server`.
  No compatible fix is currently available; Alloy does not expose that static
  file server directly, and high or critical findings remain artifact-blocking.

## Reporting

Follow the private disclosure process in the repository root
[SECURITY.md](../SECURITY.md).
