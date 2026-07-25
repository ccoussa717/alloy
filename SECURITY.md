# Security policy

## Supported versions

Alloy has no npm release yet. This policy applies to the canonical source
repository and its pre-release `main` branch.

| Version | Supported |
|---|---|
| Pre-release `main` | Best effort |

## Report a vulnerability

Do not open a public issue with exploit details, credentials, private prompts,
or customer data.

Use the repository's [private vulnerability reporting form](https://github.com/ccoussa717/alloy/security/advisories/new).
GitHub sends the report privately to the maintainer. Do not include live
credentials or customer data; use synthetic reproductions whenever possible.

Maintainers aim to acknowledge a report within three business days and provide
a status update within seven business days. Timelines for a fix depend on
severity, reproducibility, and upstream dependencies.

Include:

- affected Alloy and Node versions;
- operating system and install method;
- minimal reproduction steps;
- security impact;
- whether the issue involves Pi or another upstream package; and
- a safe way to contact you.

## Scope

Alloy is a single-operator local coding harness. Host-mode policy is not a
filesystem sandbox. Reports that rely only on another process already running
as the same operating-system user are generally outside the security boundary,
but credential leaks, policy bypasses, path escapes, unsafe defaults, and
sandbox failures are in scope.

The detailed threat model is in [docs/SECURITY.md](./docs/SECURITY.md).
