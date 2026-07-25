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
| Doctor leaks credentials | Presence and shape only; never values | provider tests |
| Release installs different code | Exact dependencies, release-included shrinkwrap, packed-artifact test, npm provenance | GitHub Actions |
| Secret enters source or history | Full-tree and full-history signature gate | security CI |

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
plaintext HTTP is limited to loopback development.

MCP stdio servers run as host processes. Configure them as deliberately as any
other executable. Published examples never execute floating npm packages.

Diagnostics run repository-defined typecheck, lint, and test commands as host
processes. Their child environment is allowlisted and excludes provider keys and
arbitrary host variables. The model-callable diagnostics tool requires approval
under the default profile, but the commands still have the operator's same-user
filesystem and network access and do not run through the Docker Bash sandbox.
`/auto` fails closed before launching agents when sandbox isolation is required.

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

- Direct executable dependencies use exact versions.
- Release artifacts include `npm-shrinkwrap.json`, and every registry artifact
  must carry an integrity hash.
- GitHub Actions installs and starts the actual packed npm artifact.
- High and critical dependency findings block tagged release artifacts and npm
  packages. Moderate findings must be reviewed and documented when no compatible
  fix exists. A public source snapshot requires an explicit, documented
  reachability and residual-risk decision; it does not waive the artifact gate.
- GitHub Actions generates a CycloneDX SBOM for each release candidate.
- npm publication requires provenance.
- The convenience installer is fetched from mutable `main` during pre-release,
  then resolves `main` once and downloads that exact source commit. It
  checksum-verifies any downloaded Node.js runtime, and npm verifies the
  shrinkwrapped dependency integrities. Review the installer before piping it
  or pin both the raw installer URL and `ALLOY_REF` to the same full commit SHA
  when the script and source must be immutable together. This source path is
  not a tagged release or npm package.
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
- Pi 0.82.0's published shrinkwrap currently pins `brace-expansion` 5.0.7,
  which is affected by the out-of-memory denial-of-service advisory
  `GHSA-mh99-v99m-4gvg`. Repository-authored model and resource patterns can
  reach this matcher only after the operator explicitly trusts the project. The
  resulting local-process availability risk is accepted for the public source
  snapshot at that trust boundary, but the high-severity finding keeps tagged
  releases and npm publication blocked until Pi ships a compatible fix. Pi
  0.82.1 remains affected, and the upstream request to regenerate the shrinkwrap
  was [closed as not planned](https://github.com/earendil-works/pi/issues/7090).
  Root npm overrides and edits that only change Alloy's lock metadata do not
  replace the actually installed Pi-owned node, so Alloy does not claim those as
  fixes. Reassess this acceptance if matching occurs before project trust or the
  impact extends beyond the local Alloy process.
- The current MCP dependency chain carries `GHSA-frvp-7c67-39w9`, a moderate
  Windows encoded-backslash path-traversal advisory in `@hono/node-server`.
  No compatible fix is currently available; Alloy does not expose that static
  file server directly, and high or critical findings remain artifact-blocking.

## Reporting

Follow the private disclosure process in the repository root
[SECURITY.md](../SECURITY.md).
