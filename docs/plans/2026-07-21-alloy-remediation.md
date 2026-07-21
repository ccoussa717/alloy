# Alloy checkpoint and dirty-baseline remediation

## Goal

Restore checkpointed staged state exactly and seed isolated worktrees with the
same staged, unstaged, and untracked baseline the planner observed.

## Acceptance criteria

1. A staged-only checkpoint round-trip restores both the file and index, with
   porcelain status `M  <path>`.
2. A tracked-only checkpoint never copies checkpoint metadata or patch files
   into the repository.
3. Staged-only worktree seeding reproduces file content, index content, and
   porcelain status without seed errors.
4. Combined staged and unstaged seeding reproduces the exact index/worktree
   split without seed errors.
5. Failed baseline application is reported as failure rather than a successful
   seed.
6. Existing untracked-file preservation and no-`git clean` guarantees remain
   green.

## Plan

1. Add focused staged-only checkpoint and staged/combined worktree tests. Done
   when they fail on `5cb8df3` for the reproduced causes.
2. Fix untracked-store selection and staged patch application with the smallest
   changes. Done when focused tests pass under Node 22.19.0.
3. Make seeding fail closed when a captured baseline cannot be reproduced.
   Done when an adversarial failed-apply test passes and no caller reports a
   successful dirty seed.
4. Run the complete unit and integration suite, CLI smoke, and package dry run
   through `npm run ci:local` under Node 22.19.0.
5. Review the exact diff adversarially, then create one focused local commit if
   every gate is green.

## Exclusions

- Child-agent policy, sandbox inheritance, and credential isolation are owned
  by Grok on `fix/alloy-grok-child-policy`.
- No push, merge, deploy, production credentials, dependency upgrades, or
  unrelated release changes.
