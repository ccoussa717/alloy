# Governance

Alloy uses a maintainer-led governance model.

## Roles

**Contributors** submit issues, documentation, tests, code, and reviews.

**Maintainers** review changes, manage releases, triage security reports, and
protect the product and security boundaries. The current maintainer is
[Chris Coussa](https://github.com/ccoussa717). Repository ownership rules live
in [`.github/CODEOWNERS`](./.github/CODEOWNERS).

## Decisions

Routine decisions are made through issue and pull-request review. Maintainers
seek technical consensus, but one approving maintainer remains accountable for
each merge. Changes to licensing, governance, security boundaries, package
identity, or compatibility policy require explicit maintainer approval and a
public decision record.

## Becoming a maintainer

Maintainers may invite a contributor who has demonstrated sustained,
high-quality work, sound security judgment, constructive review, and reliable
follow-through. Maintainer access may be removed for inactivity, security risk,
or conduct violations after documented review.

## Releases

Releases follow [docs/RELEASING.md](./docs/RELEASING.md). No maintainer may skip
the release gate or publish from an unreviewed worktree.
