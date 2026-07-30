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
7. Do not create a release tag or package artifact during the visibility change.
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

## Source-only GitHub releases

Maintainers may publish a tagged GitHub source release while npm and packaged
interactive installation remain blocked. A source release contains GitHub's
automatically generated source archives and points users to the supported
`install.sh` path pinned with `ALLOY_REF=vX.Y.Z`; it must not claim to provide an
npm package or standalone binary.

Before publishing a source release:

1. Bump the root package, TUI package, shrinkwrap, and runtime fallback versions.
2. Move the shipped changelog entries from `Unreleased` to a dated version.
3. Run `npm run ci:local`, `npm run ci:release`, and independent review.
4. Merge the release metadata through protected `main` and require green CI.
5. Tag that exact `main` commit and wait for green tag CI before creating the
   GitHub Release.
6. Download and inspect the published source archive, verify the version, and
   confirm the supported installer resolves the tag.

## Package publication is blocked

The supported distribution is the source installer. `package.json` remains
private, `prepublishOnly` exits nonzero, and `release:verify:publish`
intentionally fails. The packed artifact is generated only to verify its file
boundary and bundled Pi runtime; it is not a supported interactive installation
path because npm cannot install the Bun-managed native TUI graph safely.

Do not create an npm release, publish or attach an npm package artifact, or add a
trusted-publishing workflow until an explicit package-consumer Bun lifecycle has
been designed, approved, and verified on clean Linux and macOS machines.
Reopening package publication also requires changing the
private/package-consumer metadata and their fail-closed tests, reviewing exact
root and TUI dependency locks, running `npm run ci:release`, and obtaining
independent review of the exact release diff.

Publishing, repository visibility changes, and release announcements require
explicit maintainer authorization.
