# Alloy main-harness adoption checklist

**Purpose:** Run **Alloy** as the default coding agent shell.  
**Lens:** Alloy is org-agnostic. It may stay private or go open source — see [BOUNDARY.md](./BOUNDARY.md). Org-specific systems live **outside** this package.

| | |
|---|---|
| **Status** | Engineering security gate complete — ready for dogfood |
| **Runtime** | Alloy on Pi (pinned in `node_modules`) · Node ≥ 22.19 |
| **Boundary** | [docs/BOUNDARY.md](./BOUNDARY.md) |

---

## 0. Product boundary (read first)

- [ ] I understand Alloy has **no required dependency** on any company mesh, shared brain, or control plane
- [ ] Secrets, fleet topology, and private skill packs stay **outside** this repo
- [ ] Host mode ≠ filesystem isolation; use Docker sandbox when risk is high  
  Full table: [BOUNDARY.md](./BOUNDARY.md)

---

## 1. Machine bootstrap (every box)

- [ ] **Node ≥ 22.19** (`node -v`)
- [ ] **Git** available
- [ ] **Docker** if this host will use sandbox (optional; recommended for untrusted work)
- [ ] Install from a local clone (works offline after clone; hosting URL is not a product feature):

```bash
cd /path/to/alloy && git pull && npm install && bash scripts/install-cli.sh
# first-time clone: set ALLOY_REPO if your remote differs, then bash install.sh
```

- [ ] `alloy --version` prints **Alloy + Pi + Node**
- [ ] `which alloy` resolves
- [ ] `alloy --help` succeeds
- [ ] Upgrade Pi **via Alloy’s pin**, not only global `pi update`:  
  `npm install @earendil-works/pi-coding-agent@latest` inside the Alloy clone

---

## 2. Identity & providers

- [ ] `/login` for providers this machine uses
- [ ] `/doctor` honest — never prints secrets
- [ ] `/whoami` harness identity only
- [ ] Auth in Pi store (`~/.pi/agent/auth.json`)

---

## 3. Default safety posture

| Setting | Recommended default | Note |
|---------|---------------------|------|
| Permissions | `ask-dangerous` | Shift+Tab / `/permissions` |
| Untrusted code | `sandbox` if Docker present | Fail closed without Docker |
| Exploration | `plan` / `review` | Hard read-only |
| Implementation | `build` | `/mode build` |

- [ ] Can explain ask-all / ask-some / ask-dangerous / ask-none / sandbox
- [ ] Project config untrusted by default; trusted may only **tighten**

---

## 4. Memory (local only)

- [ ] `/remember` · `/memory list|search|forget`
- [ ] Survives `/new` / new process
- [ ] **No secrets** in memory files
- [ ] Shared company knowledge = external / MCP — not required in Alloy core

---

## 5. Skills (human-gated)

- [ ] `/skill-capture` → review → `/skill-promote`
- [ ] No unsupervised overwrite of promoted skills
- [ ] Team-specific skills in private packs or local dirs, not forced into Alloy git

---

## 6. MCP

- [ ] `~/.pi/alloy/mcp.json` from examples; **connectOnStart: false**
- [ ] Stdio **or** HTTP (streamable) **or** SSE servers configured (`url` + `headers` with `${ENV}` for tokens)
- [ ] Explicit `/mcp connect`
- [ ] Same capability gate as native tools
- [ ] No live secrets committed to Alloy or example configs

---

## 7. Daily workflow smoke (15 min)

- [ ] Tools under `ask-dangerous` (or sandbox)
- [ ] `/mode plan` blocks write
- [ ] `/checkpoint` + `/undo`
- [ ] Optional `/auto` / `/agent`
- [ ] `/help` works

---

## 8. Optional: multi-agent fleets

Only if this host is part of a fleet (any org). Alloy does not require a fleet.

- [ ] Default coding shell is `alloy`
- [ ] Fleet credentials in host env / secret store — not Alloy memory
- [ ] Untrusted trees → sandbox when Docker available
- [ ] Update harness via this repo’s pin + install-cli

---

## 9. What we do **not** claim

- [ ] Host mode ≠ isolation  
- [ ] Not multi-tenant micro-VM OS  
- [ ] Skills do not self-rewrite without approval  
- [ ] Alloy need not embed one company’s full platform  

---

## 10. Sign-off (per machine)

| Field | Value |
|-------|--------|
| Hostname | |
| Operator / agent id | |
| Alloy version | |
| Docker (y/n) | |
| Providers | |
| Date | |
| Signed | |

**Done when:** §1–7 checked; §8 if fleet host.

---

## Quick reference

```text
alloy · alloy --version · /doctor · /permissions · /mode
/remember · /skill-capture → /skill-promote · /mcp connect
/checkpoint · /undo · /auto · /agent · /fusion
```

**Upgrade:** `cd <alloy-clone> && git pull && npm install && bash scripts/install-cli.sh`  
**Boundary:** [BOUNDARY.md](./BOUNDARY.md) · **Security:** [SECURITY.md](./SECURITY.md) · **MVP:** [MVP.md](./MVP.md)
