# Alloy architecture (MVP)

```text
alloy (bin)
  └─ spawns Pi CLI
       └─ loads extensions/index.ts
            ├── providers  (/doctor, /providers)
            ├── memory     (/remember, /memory, inject)
            ├── skills-improve (/skill-capture, promote)
            ├── mcp        (/mcp, list tool)
            ├── policy     (/permissions, tool_call gate)
            └── ui         (/alloy, status)
```

**Rules**

- Do not fork Pi.
- Do not implement provider OAuth; use Pi `/login`.
- Never log credential values.
- Self-improve skills: propose → approve → write.
- MCP tools must share native policy (when bridge lands).

## Filesystem concurrency boundary

Checkpoint restore and dirty worktree seeding enumerate Git-visible untracked
entries, preserve symlinks without dereferencing them, retain regular-file mode
bits through `0o7777`, and reject containment escapes, state mismatches,
pre-existing symlink ancestors, and destination collisions they observe.
Checkpoint operations first resolve `git rev-parse --show-toplevel`; Git paths,
payload capture, project identity, metadata storage, restore, listing, and
deletion are repository-root relative even when invoked from a subdirectory.
The caller directory is recorded only as provenance.
Restore snapshots symbolic HEAD identity as well as HEAD object,
tracked/index/worktree state, enumerates the actual checkpoint target's tracked
paths, and rechecks restore-relevant ignored files and directories immediately
before mutation. Direct filesystem checks also catch empty untracked or ignored
directories that Git status does not report. Restore performs an actual
temporary create/write/unlink probe for each untracked destination. Those
checks fail closed for detected changes and capability failures.

Creation rejects any unmerged index entries before claiming a checkpoint ID or
ref. Restore preflight initializes an isolated temporary Git directory whose
detached HEAD is the authenticated checkpoint HEAD and whose object lookup uses
the source repository only as an alternate. Stash, patch, index, and
intent-to-add application are therefore exercised in the same reset context as
the real restore without consulting live HEAD or mutating the live repository.

Checkpoint creation claims its generated store ID before creating a durable
ref. New-format canonical refs point to an immutable anchor commit whose
versioned body identifies the checkpoint, canonical ref, expected HEAD,
restore/stash object, and SHA-256 digest of canonical metadata plus every stored
patch and untracked payload, including type, target, and mode. The anchor keeps
the restore object reachable as its parent. Restore and deletion require exact
root/store metadata agreement, verify the live canonical ref and anchor, and
recompute the payload digest before acting. Deletion then compare-and-swap
deletes the verified ref/object before removing discoverable metadata or stored
recovery data. Canonical checkpoint refs must be direct refs. Validation rejects
symbolic refs, and every create, cleanup, and delete compare-and-swap uses
`git update-ref --no-deref` so a ref race cannot mutate a symref target.

Legacy raw-object and immediately prior unanchored metadata have no independently
trusted marker that authenticates their mutable fields. Restore therefore fails
closed with export/migration guidance for every unversioned record. Deletion of
an unversioned record removes only that record's store and root index; it never
mutates a named Git ref.

Checkpoint restore is destructive and requires a quiescent workspace. The
synchronous APIs serialize cooperative checkpoint operations within one Alloy
process, and restore revalidates repository and checkpoint state immediately
before its first mutation. Alloy does not hold an atomic global filesystem or
Git lock that excludes an external editor, Git process, or second Alloy process
after that validation. Both ordinary and malicious external mutation in the
final window are outside the guarantee. Alloy does not claim globally atomic or
TOCTOU-safe path operations; a native descriptor-relative `openat` helper
remains separate future hardening.
