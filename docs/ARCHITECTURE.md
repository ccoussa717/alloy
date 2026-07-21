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

They are not an OS security boundary against a malicious same-UID process that
races an ancestor replacement between validation and filesystem use. Alloy does
not currently claim TOCTOU-safe path operations. A native descriptor-relative
`openat` helper is separate future hardening and is not part of the current
implementation.
