# Alloy Pi Fork

Alloy uses narrow public forks of `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui`. The coding-agent fork remains the authoritative
backend for provider authentication, credentials, sessions, commands, tools,
policy, compaction, models, and extensions.

The forked Pi renderer is no longer the default interactive UI. A normal
interactive launch uses Bun/Solid/OpenTUI with Pi as a strict local RPC child.
The Pi renderer remains available only through `--legacy-pi-ui` or
`ALLOY_LEGACY_PI_UI=1` as a temporary rollback path. Print, JSON, and explicit
RPC modes also invoke Pi directly, without the OpenTUI frontend.

## Current Runtime

| Field | Value |
|---|---|
| Package version | `0.82.1` |
| Fork | https://github.com/ccoussa717/pi |
| Source commit | `dad2d4e18235ed3b3bc889e2d1249ec3b4438e7d` |
| Release | `alloy-tui-v0.82.1.6` |

| Package | Artifact | SHA-256 | npm integrity |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | `earendil-works-pi-coding-agent-0.82.1.tgz` | `3f16996f19e735cfe7b786c88b0a12c9f8f4bda0bd008850e0c4067c87290336` | `sha512-PmKlKGGULUZ4ZgGPZcS3tR/J+9av8bnQ8G/hdzOwDaW0bTfIxLUl+woEvF4lkoBndYMYUHAv98vHMO4prT6fHg==` |
| `@earendil-works/pi-tui` | `earendil-works-pi-tui-0.82.1.tgz` | `6c939c4515c6742895e4d4c6e5926a5c735a7789d20250284dbef510efa5959c` | `sha512-0fP+idwxLCNq8a/C6CwIZ6e5B1xPck/ndxD2CSyrmhkaoPxEgY190WIGcIPHGNx51IAlDU7jHkwcOaN5MExpTQ==` |

`package.json` records the same values under `alloy.piFork`.
`scripts/verify-release.mjs` requires that metadata, resolves the shared release
tag to the declared commit, downloads both assets, recomputes their hashes, and
requires both shrinkwrap URLs and SHA-512 integrity values to match.

## Dependency Graph Decision

npm does not apply a dependency tarball's nested `npm-shrinkwrap.json` to the
consumer's installation. Alloy source checkouts and the source installer
therefore treat the root `npm-shrinkwrap.json` as the authority for their full
installed tree. A future npm consumer install would resolve dependencies under
npm's package-consumer semantics and is not covered by that guarantee. npm
publication remains blocked until its installed graph is made reproducible and
verified independently of the shrinkwrap embedded in Alloy's tarball.

The `0.82.0` to `0.82.1` lock audit observed:

- 329 previous non-root package paths and 219 current paths;
- 110 removed duplicate or nested paths and no new package paths;
- 26 same-path version changes, including the four Pi packages and AWS SDK and
  Smithy patch and minor releases;
- 102 paths directly comparable with the fork package's shrinkwrap, with 32
  different root resolutions that Alloy now pins explicitly.

Material differences from the fork package's nested shrinkwrap include
`@smithy/core` 3.24.3 to 3.30.0, Zod 3.25.76 to 4.4.3,
`google-auth-library` 10.6.2 to 10.9.1, `gaxios` 7.1.4 to 7.3.0, and type-only
`@types/node` 22.19.19 to 26.1.1. These are not described as patch-only or
automatically behavior-neutral. Alloy accepts the root resolutions only after
the compatibility and install gates below pass; provider-specific transitive
behavior remains a residual risk to recheck on every fork upgrade.

This is a deliberate dependency refresh, not a claim that the fork's nested
shrinkwrap is inherited. Acceptance requires the root integrity gate, unit and
integration suites, packed install, source installer, provider compatibility,
and live PTY viewport checks. Alloy overrides the fork's vulnerable
`brace-expansion` 5.0.7 node with patched 5.0.8 in the root shrinkwrap.

## Upgrade

1. Rebase the fork onto the selected upstream Pi tag.
2. Keep the diff within the approved viewport and message boundary.
3. Run fork tests, build, legacy-renderer PTY checks, independent review, and
   secret scans.
4. Pack the coding-agent and TUI twice from the clean tree and require identical
   hashes for both artifacts.
5. Create a fork release tag at the reviewed commit and upload both artifacts.
6. Update all `alloy.piFork` fields, the four Pi dependency pins, and overrides.
7. Regenerate the root shrinkwrap with lifecycle scripts disabled.
8. Audit and document the full lock delta, then run `npm run ci:local`, the
   OpenTUI PTY checks, and focused legacy-renderer rollback checks.

## Rollback

For an OpenTUI regression, start the same Pi backend with the prior renderer:

```bash
alloy --legacy-pi-ui
# or
ALLOY_LEGACY_PI_UI=1 alloy
```

This is a renderer rollback, not a second supported product architecture. Pi
runtime, credentials, tools, policy, sessions, and extensions remain the same.
For a backend/fork regression, revert the complete integration commit so package
metadata, shrinkwrap, verifier, tests, CI, and documentation return to one
previously reviewed runtime state. Do not delete prior release assets; they are
rollback inputs and provenance evidence.
