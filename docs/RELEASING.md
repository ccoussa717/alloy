# Releasing Alloy

Only maintainers may publish a release.

## One-time public-host setup

- Create the canonical public repository from a verified source snapshot.
- Enable private vulnerability reporting.
- Configure real CODEOWNERS identities and protected-branch review rules.
- Configure npm trusted publishing with provenance and no long-lived token.
- Publish canonical repository, issue, and support URLs in `package.json`.
- Run two clean-machine installs, including one macOS install.

Do not make the current private repository public. Its history contains
internal workflow metadata and author addresses that are unnecessary in the
public project. Start the public history from the reviewed source snapshot and
retain internal provenance privately.

## Release candidate

1. Confirm the worktree and index contain only intended changes.
2. Update `version` consistently in package metadata and the changelog.
3. Update exact dependencies deliberately; never run an unreviewed blanket
   dependency upgrade.
4. Regenerate `npm-shrinkwrap.json` from a clean temporary directory, run
   `npm run shrinkwrap:normalize -- <clean-package-lock-path>`, verify registry
   resolution and integrity fields, and review the diff. The normalizer copies
   package identity from the release tree and fills only duplicate registry
   entries whose identical tarball already has a verified integrity value
   elsewhere in the clean lock.
5. Run:

```bash
npm ci
npm run ci:local
npm run release:verify:publish
npm pack --json
```

`npm run ci:local` writes and validates `alloy.cdx.json`; review that exact file
and attach the hosted CI SBOM artifact to the release.

6. Install the produced tarball in a clean temporary project and start native
   Pi through `alloy --no-inject --list-models`.
7. Review the generated CycloneDX SBOM and dependency audit.
8. Obtain an independent review of the exact release diff.
9. Require green hosted CI, including historic secret detection and Docker.

## Publish

Publish only through the protected trusted-publishing workflow. npm provenance
must be present. Tag the exact reviewed commit and attach the SBOM and release
notes. Verify a clean install from the registry before announcing the release.

Publishing, repository visibility changes, and release announcements require
explicit maintainer authorization.
