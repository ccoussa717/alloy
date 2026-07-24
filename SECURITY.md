# Security policy

## Supported versions

Alloy has no public release yet. This policy becomes active when the canonical
public repository and private vulnerability intake are available.

| Version | Supported |
|---|---|
| Pre-release source | No public support channel |

## Report a vulnerability

Do not open a public issue with exploit details, credentials, private prompts,
or customer data.

No public vulnerability-reporting channel exists yet. Authorized pre-release
testers should contact the person who supplied the source, without technical
details, and request a private channel. Public release is blocked until the
canonical repository's private vulnerability-reporting feature is enabled.

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
