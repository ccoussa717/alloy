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
7. Checkpoint and worktree capture enumerate every untracked path with NUL-safe
   porcelain output and never copy ignored descendants hidden inside an
   untracked directory.
8. Restore preflights the checkpoint object or patches and every untracked
   destination before mutating the repository; invalid inputs, existing
   destinations, and symlink ancestors leave the current index, worktree, and
   porcelain status byte-for-byte unchanged.
9. Checkpoint stash objects remain reachable after reflog expiry and pruning,
   while untracked restore never runs `git clean`, recursively removes a user
   path, follows a destination symlink, or overwrites a collision.
10. Worktree seeding reproduces the captured NUL-delimited porcelain status,
    logical index entries including intent-to-add, staged patch, unstaged patch,
    untracked bytes, and symlink targets exactly; any mismatch is a failed seed.
11. Dangling untracked symlinks round-trip through checkpoint restore and
    worktree seeding without dereferencing their targets.
12. Final `warning` and `recoverable` values are present and identical in both
    checkpoint metadata files.

## Plan

1. Add one focused adversarial test per strengthened behavior and observe each
   fail for the expected reason before implementation changes.
2. Replace directory-level untracked capture with Git-enumerated path copies,
   using lstat-based existence and verbatim symlink handling in both modules.
3. Anchor checkpoint stash objects and preflight restore objects, patch
   applicability, containment, ancestors, and collisions before target-tree
   mutation.
4. Capture canonical porcelain/index/worktree state, reproduce intent-to-add,
   and reject a seed whose resulting state differs.
5. Persist metadata only after final warning and recovery fields are known.
6. Run the complete unit and integration suite, CLI smoke, and package dry run
   through `npm run ci:local` under Node 22.19.0.
7. Review the exact diff adversarially, then create one focused local commit if
   every gate is green.

## Exclusions

- Child-agent policy, sandbox inheritance, and credential isolation are owned
  by Grok on `fix/alloy-grok-child-policy`.
- No push, merge, deploy, production credentials, dependency upgrades, or
  unrelated release changes.
