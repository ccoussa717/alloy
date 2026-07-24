# Alloy open-source readiness plan

## Goal

Prepare Alloy for a future public MIT release without publishing it. The
release tree must be organization-neutral, installable from its packed npm
artifact, contributor-ready, and protected by release-gating security checks.

## Constraints

- Preserve the `alloy` CLI and provider functionality.
- Keep Pi attribution and third-party license obligations accurate.
- Do not invent a public repository URL or security contact.
- Do not change repository visibility, publish npm, push, or merge.
- Treat public release as blocked until a canonical host and private security
  reporting channel exist.

## Steps

1. Fix packed-artifact Pi discovery and add a clean tarball installation test.
   Done when the installed `alloy` binary starts native Pi from a temporary
   project without relying on a global `pi` binary.
2. Pin executable dependencies and replace unpinned MCP examples. Done when a
   clean `npm ci` resolves one compatible Pi family and examples execute no
   floating npm package.
3. Remove organization-specific package, URL, theme, maintainer, internal
   issue, branch, and agent-signoff references. Done when targeted repository
   searches return no organization identifiers.
4. Add contribution, conduct, governance, support, security, ownership,
   changelog, and release documentation. Done when a new contributor can find
   one clear path for setup, changes, review, support, and disclosure.
5. Make CI block on the complete integration, packed-install, dependency, and
   secret-scanning gates. Done when the local equivalents all pass.
6. Run clean-install, unit, integration, package, dependency, license,
   full-history, and CLI smoke verification. Done when observed results are
   recorded without skipped release-critical paths.
7. Obtain an independent exact-diff review and resolve every must-fix finding.

## Release blockers outside this change

- Choose and create the canonical public repository.
- Enable a private vulnerability-reporting channel on that repository.
- Configure host-native CODEOWNERS identities and branch protection.
- Publish the first npm version with provenance only after explicit approval.
