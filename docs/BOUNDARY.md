# Alloy product boundary

Alloy is a **generic coding agent harness** on [Pi](https://pi.dev). It must remain usable by any operator **without** any particular company’s mesh, knowledge base, or control plane.

This boundary is required whether the repo stays private **or** is published open source. Opening the source should not require stripping product features—only packaging, reporting URLs, and hosting.

---

## In scope (this repository)

| Area | What ships |
|------|------------|
| Launcher | `alloy` CLI, theme, extension inject |
| Policy | Modes, ask-levels, capability gate, project trust |
| Children | Runner, enforcer, sandbox spawn plans, credential boundaries |
| Memory | Local durable user/project facts (`/remember`, `/memory`) |
| Skills | Capture → human approve → promote mechanism + starter skills |
| MCP | Config shape + stdio / HTTP (streamable) / SSE bridges; tools under the same gate |
| Orchestration | `/auto`, `/fusion`, `/agent` primitives |
| Git | Checkpoints, worktrees, diagnostics helpers |
| Docs | Architecture, security model, adoption checklist |

---

## Out of scope (never required inside this package)

| Area | Where it lives instead |
|------|------------------------|
| Company secrets / API keys / hub tokens | Host env, secret store, operator machine |
| Multi-agent mesh topology | Separate ops / fleet repos |
| Shared company knowledge bases | External product or MCP the operator configures |
| Client playbooks / private skill packs | Private repos or local skill dirs |
| Production MCP endpoints with live keys | Operator `~/.pi/alloy/mcp.json` (gitignored secrets) |
| Hosted control plane / billing | Separate products |

**Rule:** if open-sourcing a file would leak customers, fleet layout, or credentials, it does not belong in Alloy. If it is a reusable *mechanism*, it can stay.

---

## Isolation honesty (always)

| Mode | Guarantee |
|------|-----------|
| Host ask-levels | Policy + scrubbed child env + isolated HOME / `PI_CODING_AGENT_DIR` pointers. **Not** a filesystem jail. |
| Docker sandbox | Stronger isolation for paths Alloy routes through the container. Fail closed without Docker. Not a multi-tenant micro-VM product. |

Do not describe host mode as “isolation.”

---

## Dual path

| Path | Changes | Does not change |
|------|---------|-----------------|
| Private hosting | Access control, clone URL | Product boundary above |
| Public open source | Canonical URL, SECURITY reporting, SBOM/CODEOWNERS launch gate | Same core; org packs remain outside |

See also: [OPERATIONS.md](./OPERATIONS.md), [SECURITY.md](./SECURITY.md).
