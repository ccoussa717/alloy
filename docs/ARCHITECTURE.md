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
