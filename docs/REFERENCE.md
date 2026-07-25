# Alloy reference

This guide is the operational reference for the current pre-release source. For
the product overview and fastest setup path, start with the
[README](../README.md).

## Requirements and installation

- Node.js 22.19 or newer
- npm
- Git
- macOS or Linux
- Docker only when using the sandbox permission profile or running the complete
  release verification suite

The npm package is not published. Install from a clone:

```bash
git clone https://github.com/ccoussa717/alloy.git
cd alloy
npm ci
npm link
alloy --version
```

Contributors must use `npm ci`, not `npm install`. Release dependencies are
governed by `npm-shrinkwrap.json`.

## Launch and CLI options

Launch Alloy from the repository you want it to inspect:

```bash
cd /path/to/project
alloy
```

Useful Pi CLI flags pass through the Alloy launcher:

```bash
alloy --version
alloy --model anthropic/<model-id>
alloy --model openai-codex/<model-id>
alloy --model xai/<model-id>
alloy --thinking high
alloy --no-inject --list-models
```

## Authentication and providers

Pi owns provider authentication and stores credentials in
`~/.pi/agent/auth.json`.

| Route | Setup | Notes |
|---|---|---|
| Anthropic subscription | `/login` | Claude Pro/Max route. |
| ChatGPT/Codex subscription | `/login` | Models use the `openai-codex/...` prefix. |
| Grok subscription | `/login xai` | xAI subscription route. |
| Anthropic API | `ANTHROPIC_API_KEY` | API provider route. |
| OpenAI API | `OPENAI_API_KEY` | Models use the `openai/...` prefix, not `openai-codex/...`. |
| xAI API | `XAI_API_KEY` | API provider route. |

Use `/providers` for a short status report and `/doctor` for versions, provider
status, model defaults, economics, Docker, and paths. Neither command prints
secret values. `/whoami` reports model identity from harness state rather than
asking the model to identify itself.

## Operating modes

Modes define what kind of work is mechanically possible. They are independent
from approval profiles.

| Mode | Behavior |
|---|---|
| `chat` | General conversation and light coding under the active approval profile. |
| `plan` | Model tool calls are hard read-only. Bash, writes, mutations, child workflows, diagnostics, and MCP tools are denied. |
| `build` | Implementation under the active approval profile. |
| `review` | Model tool calls use a hard read-only independent review posture. |

```text
/mode chat|plan|build|review
/plan
/build
/review
```

`Shift+Tab` cycles Build and Plan.

Modes gate model-initiated tool calls. Operator-invoked slash commands are a
separate control plane: commands such as `/undo`, `/worktree`, and `/auto` may
still mutate state when you invoke them directly.

## Approval profiles

Approval profiles decide when a permitted action requires operator approval.
Model tool calls in Plan and Review remain read-only regardless of profile.

| Profile | Behavior |
|---|---|
| `ask-all` | Approve every write, edit, process, persistent-state, child-agent, and external action. |
| `ask-some` | Approve edits, shell commands, child agents, memory writes, MCP, and other non-read capabilities. |
| `ask-dangerous` | Default. Approve known dangerous shell patterns, destructive Git, MCP, and tools classified as network or external actions. |
| `ask-none` | Full autonomy in Build or Chat. No approval prompts. |
| `sandbox` | Route Bash through Docker and otherwise use `ask-dangerous` approval behavior. |

```text
/permissions
/permissions ask-some
/permissions cycle
/permissions sandbox
```

Aliases: `/ask` and `/permission`.

Legacy profile aliases remain accepted: `safe` maps to `ask-dangerous`,
`workspace` maps to `ask-none`, and `readonly` maps to `ask-all`. Plan mode is
still the mechanical read-only control.

`ask-dangerous` is not a network egress filter. Ordinary Bash commands such as
`curl` or `ssh` run without approval unless they match a configured dangerous
pattern. Use the Docker sandbox with `network=none` when network isolation is
required.

### Docker sandbox

The sandbox profile routes Bash and `!shell` through a session container:

| Setting | Default |
|---|---|
| Image | `node:22-bookworm` |
| Network | `none` |
| Project mount | current directory to `/workspace` |
| Memory | `2g` |
| CPUs | `2` |
| Linux controls | `--cap-drop ALL`, `no-new-privileges` |

```text
/sandbox
/sandbox doctor
/sandbox start
/sandbox stop
```

The profile fails closed if Docker is unavailable. It isolates Bash, not the
entire host process: MCP servers and repository diagnostics are still host
processes. `/auto` therefore fails closed before launching agents when sandbox
is required because its diagnostics cannot satisfy that isolation boundary.

## Core Alloy commands

### Harness and providers

| Command | Purpose |
|---|---|
| `/alloy` | Show harness summary and current state. |
| `/doctor` | Diagnose versions, providers, model defaults, Docker, and paths. |
| `/providers` | Show Anthropic, Codex, and Grok route status. |
| `/whoami` | Show authoritative harness and model identity. |
| `/honesty` | Show the active evidence and non-invention policy. |
| `/help [topic]` | Browse Alloy documentation. |
| `/help search <query>` | Search all help topics. |
| `/help commands` | Render the complete live Pi and Alloy command registry. |
| `/effort [level]` | Show or set reasoning effort. |
| `/thinking [level]` | Alias for `/effort`. |

Effort levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Pi clamps unsupported values to the selected model's capabilities.

### Memory and skills

| Command | Purpose |
|---|---|
| `/remember <fact>` | Save a project-scoped durable fact. |
| `/remember user: <fact>` | Save a user-global durable fact. |
| `/memory list` | List durable facts. |
| `/memory search <query>` | Search durable facts. |
| `/memory forget <id>` | Delete a durable fact. |
| `/skill:<name>` | Invoke an installed Agent Skill. |
| `/skill-capture <name>` | Create a draft skill. |
| `/skill-promote <name>` | Approve and install a draft skill. |
| `/skill-drafts` | List draft skills. |

Do not store credentials or other secrets in memory. Skill self-improvement is
`propose -> approve -> promote`; Alloy does not silently install drafts.

### Recovery, diagnostics, and MCP

| Command | Purpose |
|---|---|
| `/checkpoint [label]` | Capture an authenticated Git snapshot. |
| `/checkpoints` | List snapshots. |
| `/undo [id]` | Restore a snapshot after confirmation; headless use is denied. |
| `/worktree create [role] [taskId]` | Create an isolated builder worktree. |
| `/worktree list` | List Alloy worktrees. |
| `/worktree diff <id>` | Inspect a worktree diff. |
| `/worktree remove <id>` | Remove an Alloy worktree; the TUI confirms, while headless direct invocation does not. |
| `/diagnose [--no-test]` | Detect the stack and run available checks. |
| `/mcp list` or `/mcp status` | Show servers and tool counts. |
| `/mcp tools` | Show full registered MCP tool names. |
| `/mcp connect` | Start enabled servers and register tools. |
| `/mcp disconnect` | Disconnect servers. |
| `/mcp reload` | Disconnect, reload configuration, and reconnect enabled servers. |
| `/mcp path` | Show active MCP configuration paths. |

Checkpoints are recovery snapshots, not backups. Push important work to a
remote.

Diagnostics may execute repository-defined package scripts and toolchain
commands as the current host user. Their environment is allowlisted to exclude
provider keys and arbitrary host variables, and model-triggered diagnostics
require approval under the default profile. Review the complete command body in
the approval prompt.

### Agents and workflows

| Command | Purpose |
|---|---|
| `/agent <name> <task>` | Launch an isolated child with inferred routing. |
| `/agent <name> profile=<profile> <task>` | Launch with a configured profile. |
| `/agent <name> model=<provider/id> <task>` | Launch with an explicit model route. |
| `/agent bg <name> <task>` | Launch in the background. |
| `/agents` | List child agents. |
| `/agents view <id|name>` | Open a child transcript. |
| `/profiles` | Show the configured model profile map. |
| `/last-agent` | Show the most recent agent result. |
| `Ctrl+Shift+A` | Open the most recent agent transcript. |
| `/fusion <objective>` | Run read-only Architect, Builder, and Synthesizer roles. |
| `/fusion setup` | Select and save Fusion role models. |
| `/fusion status` | Show Fusion readiness. |
| `/fusion help` | Explain the Fusion workflow and configuration. |
| `/auto <request>` | Run Scout, Planner, Builder, diagnostics, Reviewer, and bounded Fixer rounds. |
| `/runs` | Show the run artifact root. |
| `/panel` | Clear the live workflow panel. |
| `/chrome` | Clear Alloy's custom header, footer, editor, and splash until restart. |

Child policy manifests constrain approval profile, sandbox requirement, allowed
tools, budget, and concurrency. Model-invoked child tools are denied in Plan and
Review. Operator-invoked `/auto` is an explicit control-plane action: Builder
and Fixer roles launch in Build mode even if the current mode is Plan or Review.
Interactive use confirms first; headless direct invocation does not. Provider
credentials are allowlisted rather than copying the complete host environment.

Fusion is plan-only. Architect and Builder inspect independently, and a fresh
Synthesizer receives both validated proposals. An eligible successful run
launches exactly three child-agent roles. Each role may use multiple model turns
while reading the repository. Auth, abort, validation, and budget failures stop
earlier.

Auto attempts a checkpoint when running in a Git repository, prefers a worktree,
and runs up to `budgets.maxFixRounds` fix rounds after diagnostic or review
failure. Checkpoint failure is recorded but does not stop the subsequent build.
Auto records run metadata, patches, and raw diagnostic output under the Alloy
home directory. Treat run artifacts as operator data because repository scripts
control their output and can print sensitive text.

## Native Pi commands

Alloy preserves Pi's native command surface:

| Command | Purpose |
|---|---|
| `/settings` | Open Pi settings. |
| `/model` | Select a provider and model. |
| `/scoped-models` | Choose models included in model cycling. |
| `/login [provider]` | Configure provider authentication. |
| `/logout` | Remove provider authentication. |
| `/new` | Start a new session. |
| `/resume` | Resume another session. |
| `/session` | Show session information and usage. |
| `/name` | Set the session display name. |
| `/compact` | Compact the current context. |
| `/fork` | Fork from a previous user message. |
| `/clone` | Duplicate the current session position. |
| `/tree` | Navigate the session tree. |
| `/export` | Export a session to HTML or JSONL. |
| `/import` | Import and resume a JSONL session. |
| `/share` | Share a session as a secret GitHub gist. |
| `/copy` | Copy the last agent message. |
| `/trust` | Save a project trust decision. |
| `/hotkeys` | Show keyboard shortcuts. |
| `/reload` | Reload extensions, skills, prompts, themes, and context. |
| `/changelog` | Show runtime changelog entries. |
| `/quit` | Exit Pi. |

`/help commands` is authoritative for the commands active in the current
session, including prompts and installed skills.

## Configuration

Alloy creates `~/.pi/alloy/config.json` on first use. The complete example is
[`config/alloy.example.json`](../config/alloy.example.json).

A minimal global configuration:

```json
{
  "version": 1,
  "defaultMode": "build",
  "permissionProfile": "ask-dangerous",
  "memory": {
    "enabled": true,
    "maxInjectChars": 6000,
    "autoLoad": true
  },
  "mcp": {
    "enabled": true,
    "connectOnStart": false
  },
  "budgets": {
    "maxCostUsd": 25,
    "maxFixRounds": 2
  }
}
```

### Configuration precedence and trust

1. Built-in defaults load first.
2. Operator-trusted `~/.pi/alloy/config.json` overrides the defaults.
3. `.pi/alloy.json` loads only for a trusted project. Its security-sensitive
   overrides are constrained, while workflow preferences remain configurable.

A project cannot replace a global sandbox profile with a weaker approval
profile, raise global budgets, enable MCP when globally disabled, enable MCP
auto-connect, or override global-only sandbox image, network, environment,
pull, mount, and engine settings. A trusted project may choose `defaultMode`,
role routing, Fusion settings, and Auto preferences including
`auto.useWorktree`. It may also replace profile tool lists and system prompts,
not just profile models. Review trusted project config as executable policy,
not as untrusted data.

### Model routing

Agent profiles live under `profiles` in the global or trusted project config.
The default role intent is:

| Profile | Default job |
|---|---|
| `research` | Repository exploration and research with read tools. |
| `code` | Implementation with read, write, edit, and Bash tools. |
| `review` | Independent read-only review. |
| `plan` | Read-only planning. |
| `default` | General tasks using the active model when unset. |

Fusion routes are explicit:

```json
{
  "fusion": {
    "architectModel": "anthropic/<model-id>",
    "builderModel": "openai-codex/<model-id>",
    "synthesizerModel": "anthropic/<model-id>",
    "architectEffort": "high",
    "builderEffort": "medium",
    "synthesizerEffort": "high"
  }
}
```

Use `/fusion setup` to choose from authenticated models and save this block.

## MCP configuration

Use `~/.pi/alloy/mcp.json` for operator configuration or
`.pi/alloy-mcp.json` in a trusted project. See the complete
[`config/mcp.example.json`](../config/mcp.example.json).

```json
{
  "version": 1,
  "servers": {
    "reviewed-local": {
      "transport": "stdio",
      "command": "/absolute/path/to/reviewed-mcp-server",
      "args": [],
      "env": {},
      "enabled": false
    },
    "reviewed-remote": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_HTTP_TOKEN}"
      },
      "enabled": false
    }
  }
}
```

Supported transports are stdio, Streamable HTTP, and legacy SSE. Use exact,
reviewed executables for stdio servers; avoid floating `npx -y <package>`
commands. Non-loopback HTTP and SSE servers must use HTTPS.

Put expanded header secrets in `~/.pi/alloy/env` with mode `0600`; never commit
them. MCP tool names use a sanitized, length-bounded
`mcp_<server>_<tool>_<hash>` form. Run `/mcp tools` for the exact callable name.
MCP tools default to the `external_side_effect` capability, so they require
approval under `ask-dangerous`.

## Filesystem layout

```text
~/.pi/agent/
  auth.json                    Pi provider credentials
  sessions/                    Pi session trees
  skills/                      installed user skills

~/.pi/alloy/
  config.json                  operator configuration
  mcp.json                     operator MCP configuration
  env                          MCP secret expansion values
  memory/user/                 user-global facts
  memory/projects/<id>/        project facts
  skills-drafts/               unapproved skill drafts
  runs/<project>/<run-id>/     agent workflow artifacts
  checkpoints/                 recoverable Git snapshots
  worktrees/                   isolated child worktrees

<project>/.pi/
  alloy.json                   trusted project configuration
  alloy-mcp.json               trusted project MCP configuration
```

Supported path overrides:

| Variable | Purpose |
|---|---|
| `ALLOY_HOME` | Override `~/.pi/alloy`. |
| `PI_CODING_AGENT_DIR` | Override `~/.pi/agent`. |
| `ALLOY_PI_BIN` | Override the Pi executable used for child processes. |

The launcher exports `ALLOY_ROOT` to child processes as the resolved installed
package root. It is runtime information, not a supported user override.

## Troubleshooting

### A provider is missing or expired

Run `/doctor`, then reconnect only that route with `/login` or `/login xai`.
API keys do not authenticate `openai-codex/...`; that route uses ChatGPT/Codex
subscription authentication.

### Sandbox will not enable

Run `/sandbox doctor`. The Docker CLI and daemon must both be available. Alloy
does not fall back to host Bash when sandbox is required.

### Fusion is not ready

Run `/fusion status`, connect the required providers, then run `/fusion setup`.
All three roles need configured, authenticated model routes.

### Project configuration is ignored

Run `/trust` and restart the session. Project configuration is ignored until
the repository is trusted. Overrides to constrained approval, sandbox, MCP, and
budget fields that weaken global policy remain rejected after trust; trusted
workflow profiles and preferences are not restricted to tighten-only changes.

### MCP tools do not appear

Check `/mcp status`, confirm the server is enabled, then run `/mcp connect`.
Use `/mcp tools` to inspect registered names. Keep `connectOnStart` disabled
until every configured server is trusted.

### A checkpoint cannot restore

`/undo` requires an interactive confirmation and a compatible repository state.
Use `/checkpoints` to identify the snapshot. Checkpoints are not remote backups.

### Alloy cannot find its bundled Pi CLI

Run `npm ci` from the Alloy clone and relink with `npm link`. Alloy prefers the
Pi dependency bundled with its own installation, then searches global npm roots,
prefix locations, and `PATH` as recovery fallbacks. A global `pi update` does
not change Alloy while its bundled pinned runtime resolves, but it can affect a
fallback installation.

## Verification

Run the local verification bundle:

```bash
npm run ci:local
```

This runs unit and integration tests, version and package checks, release
metadata verification, the security scan, and CycloneDX SBOM generation. It
does not run the high-severity publication audit from `npm run ci:release`.
Docker integration skips locally when Docker is unavailable; GitHub Actions
sets `ALLOY_REQUIRE_DOCKER_TEST=1`, so hosted release verification cannot pass
without it.

For security boundaries and residual risks, read [SECURITY.md](SECURITY.md).
