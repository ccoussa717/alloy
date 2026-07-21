# Alloy MVP contract

## In

1. Subscription login paths for Anthropic Claude, OpenAI Codex/ChatGPT, xAI Grok (via Pi `/login`).
2. Durable cross-session memory (user + project).
3. Skills: create, compose (skills using skills), self-improve with approval.
4. MCP server configuration and discovery (live tool bridge follows).
5. Basic harness via Pi: TUI, tools, sessions, tree, compact, AGENTS.md, model switch.
6. Safe-by-default permission profile.

## Out

- Multi-agent factory (`/auto`, fusion)
- Micro-VM sandbox
- Extra providers beyond the three
- GUI / hosted control plane

## Exit test

- [ ] `/login` works for all three subscriptions (or honest `/doctor` status)
- [ ] Real repo work with tools
- [ ] `/remember` fact visible after `/new` / new process
- [ ] `/skill-capture` → `/skill-promote` installs skill
- [ ] `/mcp` shows configured servers
- [ ] No secrets in memory files, drafts, or doctor output
