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
   destination before mutating the repository; detected invalid inputs,
   existing destinations, and pre-existing symlink ancestors leave the current
   index, worktree, and porcelain status byte-for-byte unchanged.
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
13. Any failure after a durable checkpoint ref is anchored compensates by
    removing the exact ref with compare-and-swap and deleting its partial store
    and root index entry. Cleanup failure preserves the original error and names
    any ref that may remain.
14. Filesystem preservation is fail-closed for state changes it detects and for
    pre-existing symlink/collision paths. Restore requires a quiescent workspace:
    synchronous calls serialize cooperative operations within one Alloy process,
    but no atomic global lock excludes ordinary or malicious external mutation
    after final validation, and the implementation does not claim TOCTOU safety.
15. Restore snapshots exact logical HEAD, NUL status, index entries, staged
    patch, and worktree patch state before preflight and rejects any observed
    change immediately before reset or apply.
16. Every untracked restore destination passes an actual temporary exclusive
    create/write/unlink capability probe before tracked state can change.
17. Checkpoint fallback capture and restore preserve intent-to-add NUL status,
    logical index state, and worktree bytes when `git stash create` cannot
    represent that valid state.
18. A pre-existing root checkpoint index collision is never claimed or deleted;
    the owned partial store and durable ref are still compensated.
19. Untracked regular-file modes through `0o7777`, including setuid, setgid, and
    sticky bits, are restored and worktree-seeded explicitly and independently
    of the process umask.
20. Exact checkpoint IDs take precedence, while non-exact prefixes matching
    multiple checkpoints fail before repository mutation.
21. Checkpoint creation claims a generated store ID before creating its durable
    ref and uses zero-old-object compare-and-swap, so duplicate IDs cannot alter
    an existing checkpoint's metadata, store, ref, or restore capability.
22. Checkpoint deletion compare-and-swap deletes the recorded durable ref/object
    before removing metadata or recovery data; ref deletion failure is reported
    and leaves the checkpoint fully discoverable.
23. Modern checkpoint restore and deletion require the canonical ref derived
    from the checkpoint ID and require its live object to equal recorded
    `refObject`; metadata substitution cannot target another checkpoint.
24. Legacy metadata with a raw object ID and no `refObject` restores only after
    stash-like validation and deletes only its own metadata/store/index without
    treating the raw object as an owned named ref.
25. Final restore revalidation includes symbolic HEAD identity and
    restore-relevant ignored collision state, so a same-object branch switch or
    late ignored destination fails before Alloy mutation.
26. New checkpoint canonical refs own immutable anchor commits that bind the
    checkpoint ID, canonical ref, HEAD, restore object, matching metadata
    copies, patches, and untracked payload bytes, symlink targets, and modes to
    a versioned SHA-256 manifest digest verified before restore and deletion.
27. Legacy raw-object and immediately prior unanchored modern restore remains
    available only for tracked state fully authenticated by a validated stash
    object. Formats requiring unauthenticated external payloads fail closed with
    export/migration guidance; deletion remains safe and scoped.

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
6. Compensate failed checkpoint creation by deleting its exact durable ref with
   compare-and-swap and removing partial store/index artifacts.
7. Document the current concurrency boundary and defer a native
   descriptor-relative `openat` helper as separate future hardening.
8. Revalidate tracked/index/worktree state after preflight, probe destination
   writability, and preserve intent-to-add and regular file modes exactly.
9. Reject ambiguous checkpoint prefixes and preserve pre-existing root index
   collisions while compensating owned state.
10. Establish create-only durable-ref ownership and make checkpoint deletion
    ref-first and compare-and-swap guarded.
11. Enforce modern metadata/ref integrity while retaining raw-object legacy
    restore and artifact-only deletion compatibility.
12. Document synchronous cooperative serialization, the quiescent-workspace
    requirement, and the absence of atomic global exclusion for external writes.
13. Bind checkpoint metadata and every stored payload to a versioned immutable
    Git anchor while retaining only the safely derivable compatibility subset.
14. Revalidate symbolic HEAD and ignored restore collisions, and preserve
    untracked modes through `0o7777` in restore and worktree seeding.
15. Run the complete unit and integration suite, CLI smoke, and package dry run
    through `npm run ci:local` under Node 22.19.0.
16. Review the exact diff adversarially, then create one focused local commit if
    every gate is green.

## Exclusions

- Child-agent policy, sandbox inheritance, and credential isolation are owned
  by Grok on `fix/alloy-grok-child-policy`.
- No push, merge, deploy, production credentials, dependency upgrades, or
  unrelated release changes.
- No native descriptor-relative `openat` helper in this release follow-up.
