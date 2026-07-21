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
entries, preserve symlinks without dereferencing them, and reject containment
escapes, state mismatches, pre-existing symlink ancestors, and destination
collisions they observe. Restore also snapshots tracked/index/worktree state,
revalidates it immediately before mutation, and performs an actual temporary
create/write/unlink probe for each untracked destination. Those checks fail
closed for detected changes and capability failures.

Checkpoint creation claims its generated store ID before creating a durable
ref, and creates that ref only when its previous object is the zero object.
Deletion performs the inverse ownership check: it compare-and-swap deletes the
recorded ref/object before removing discoverable metadata or stored recovery
data.

Checkpoint restore is destructive and requires a quiescent workspace. The
synchronous APIs serialize cooperative checkpoint operations within one Alloy
process, and restore revalidates repository state immediately before its first
mutation. Alloy does not hold an atomic global filesystem or Git lock that
excludes an external editor, Git process, or second Alloy process after that
validation. Both ordinary and malicious external mutation in the final window
are outside the guarantee. Alloy does not claim globally atomic or TOCTOU-safe
path operations; a native descriptor-relative `openat` helper remains separate
future hardening.
