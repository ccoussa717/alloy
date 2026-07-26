# Alloy Pi Fork

Alloy uses a narrow public fork of `@earendil-works/pi-coding-agent` for the
full-terminal transcript viewport. Provider authentication, sessions, commands,
tools, compaction, model handling, and extension APIs remain Pi behavior.

## Current Runtime

| Field | Value |
|---|---|
| Package | `@earendil-works/pi-coding-agent` |
| Package version | `0.82.1` |
| Fork | https://github.com/ccoussa717/pi |
| Source commit | `6e213240c0987a05c4703dae8f7efa21be181a68` |
| Release | `alloy-tui-v0.82.1.2` |
| Artifact | `earendil-works-pi-coding-agent-0.82.1.tgz` |
| SHA-256 | `a6ff2cb5ffbcfb08f2c31f205162edff742a546c5dc050363d15abcc1db0b056` |
| npm integrity | `sha512-7ymlfDCrgnSA3T2yXp4wNe0xQcR2JT4mt6HpzLY32D3KysnPLeGWD8zIMW204BQXGqmUDFLnNjppLU1pJ2OB5A==` |

`package.json` records the same values under `alloy.piFork`.
`scripts/verify-release.mjs` requires that metadata, resolves the release tag to
the declared commit, downloads the asset, recomputes both hashes, and requires
the shrinkwrap URL and SHA-512 integrity to match.

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
and live PTY viewport checks. The known `brace-expansion` advisory remains
documented in [SECURITY.md](./SECURITY.md).

## Upgrade

1. Rebase the fork onto the selected upstream Pi tag.
2. Keep the diff within the approved viewport and message boundary.
3. Run fork tests, build, PTY checks, independent review, and secret scans.
4. Pack the coding-agent twice from the clean tree and require identical hashes.
5. Create a fork release tag at the reviewed commit and upload the artifact.
6. Update all `alloy.piFork` fields, the four Pi dependency pins, and overrides.
7. Regenerate the root shrinkwrap with lifecycle scripts disabled.
8. Audit and document the full lock delta, then run `npm run ci:local` and the
   live 80x24 and 40x10 main-chat checks.

## Rollback

Revert the complete Alloy integration commit so package metadata, shrinkwrap,
verifier, tests, CI, and documentation return to one previously reviewed runtime
state. Run `npm ci --ignore-scripts`, then repeat the local release and PTY gates.
Do not delete prior release assets; they are rollback inputs and provenance
evidence.
