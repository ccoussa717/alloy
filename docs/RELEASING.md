# Releasing Alloy

Only maintainers may publish a release.

## Public source launch

Making the canonical GitHub repository public is separate from publishing an
npm package. A public source pre-release may launch while `package.json` remains
`private` and the npm release gate remains closed.

Before changing repository visibility:

1. Confirm `main` is clean, pushed, and green in GitHub Actions.
2. Confirm history begins with the verified public release snapshot and excludes
   private development history.
3. Run `npm run ci:local`, `npm run release:verify:source`, and review the
   generated SBOM. The source verifier must confirm npm publication is disabled.
4. Run the tracked-tree, release-worktree, and full-history secret scan.
5. Confirm canonical URLs, CODEOWNERS identity, support, security, contribution,
   license, and attribution documents are present.
6. Confirm known dependency advisories and other residual risks are accurately
   disclosed in [SECURITY.md](./SECURITY.md).
7. Do not create a release tag or package artifact.
8. Obtain explicit maintainer authorization for the visibility change.

Immediately after the repository becomes public:

1. Enable private vulnerability reporting and verify the root
   [SECURITY.md](../SECURITY.md) advisory link opens the private form.
2. Protect `main` and require the GitHub Actions `verify` status check. Apply
   review and CODEOWNERS rules appropriate for the current maintainer team.
3. Reconfirm read-only default workflow permissions, DCO sign-off, merge
   methods, issue settings, Dependabot alerts, and automated security fixes.
4. Clone the public URL without existing credentials, run the documented source
   setup, and verify the rendered README and all public links.
5. Run hosted CI again against the exact public `main` commit.

GitHub Free does not expose branch protection for this private repository, and
GitHub offers private vulnerability reporting only for public repositories. The
pre-launch `403`/`404` responses are therefore expected; the controls must be
enabled immediately after the authorized visibility flip.

The high-severity transitive advisory documented in
[SECURITY.md](./SECURITY.md) blocks npm publication. Repository-authored model
and resource patterns can reach the affected Pi dependency only after the
operator explicitly trusts the project. The remaining availability risk is
accepted for this source snapshot at that trust boundary; it is not accepted for
a tagged release or npm package. Do not remove or suppress the finding, and
reassess this decision if the trust boundary or impact changes.

## One-time package-host setup

- Configure npm trusted publishing with provenance and no long-lived token.
- Run two clean-machine installs, including one macOS install.

## Release candidate

This section governs tagged release and npm package candidates, not the public
source snapshot.

1. Confirm the worktree and index contain only intended changes.
2. Update `version` consistently in package metadata and the changelog.
3. Update exact dependencies deliberately; never run an unreviewed blanket
   dependency upgrade.
4. Regenerate `npm-shrinkwrap.json` from a clean temporary directory, run
   `npm run shrinkwrap:normalize -- <clean-package-lock-path>`, verify resolution
   and integrity fields, and review the diff. Registry packages must resolve from
   npm. The coding-agent and TUI exceptions must exactly match `alloy.piFork`:
   public `ccoussa717/pi` release URLs, one full source commit and package
   version, and separate SHA-256 and npm SHA-512 integrity values. Release
   verification resolves their shared tag through GitHub, downloads both
   artifacts, and recomputes every digest. The normalizer copies
   package identity from the release tree and fills only duplicate registry
   entries whose identical tarball already has a verified integrity value
   elsewhere in the clean lock.
   The verifier requires outbound HTTPS access to `api.github.com` and the
   pinned `github.com` release asset. CI may provide `GITHUB_TOKEN` or
   `GH_TOKEN` for authenticated GitHub API rate limits; the verifier never logs
   the token.
   Review and record the root-lock dependency delta because npm does not apply a
   dependency tarball's nested shrinkwrap to Alloy's installation. Follow
   [PI_FORK.md](./PI_FORK.md) for the audit and rollback procedure.
5. Run:

```bash
npm ci
npm run ci:release
npm run release:verify:publish
npm pack --json
```

`npm run ci:release` writes and validates `alloy.cdx.json`; review that exact file
and attach the GitHub Actions SBOM artifact to the release.

6. Install the produced tarball in a clean temporary project and start native
   Pi through `alloy --no-inject --list-models`.
7. Review the generated CycloneDX SBOM and dependency audit.
8. Obtain an independent review of the exact release diff.
9. Require green GitHub Actions, including historic secret detection and Docker.

## Publish

Publish only through the protected trusted-publishing workflow. npm provenance
must be present. Tag the exact reviewed commit and attach the SBOM and release
notes. Verify a clean install from the registry before announcing the release.

Publishing, repository visibility changes, and release announcements require
explicit maintainer authorization.
