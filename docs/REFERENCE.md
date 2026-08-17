# Alloy reference

This guide is the operational reference for the current release and source. For
the product overview and fastest setup path, start with the
[README](../README.md).

## Requirements and installation

- macOS or glibc-based Linux x64/arm64 for the default interactive frontend;
  Alpine and other musl-based distributions are unsupported
- Node.js 22.19+ and Bun 1.3.14
- `curl`, `tar`, `unzip`, and `sha256sum` or `shasum`
- Git for repository workflows
- Docker only when using the sandbox permission profile or running the complete
  release verification suite
- `tmux` only for contributor PTY and full local verification

The npm package is not published. The one-command source installer reuses
Node.js 22.19+ when available. Otherwise it downloads the official Node.js
22.19.0 archive into `~/.local/share/alloy` and verifies its pinned SHA-256. It
also downloads and verifies the pinned Bun 1.3.14 artifact for Linux or macOS
x64/arm64, installs Alloy's shrinkwrapped npm dependencies, and installs the
TUI's frozen production dependencies.

```bash
curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/main/install.sh | bash
```

The convenience command fetches the installer from `main`, then installs the
latest stable GitHub release tag. Set `ALLOY_CHANNEL=main` for the tip of `main`,
or `ALLOY_REF` for an explicit tag or commit.
Writable, regular Bash and Zsh startup files load the generated environment
after a restart. For another shell, symlinked dotfiles, or an unexported custom
`ZDOTDIR`, add `~/.local/bin` to `PATH` or run `~/.local/bin/alloy` directly. For
an immutable install, pin both the fetched script and source archive to the same
full commit SHA:

```bash
curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/<full-commit-sha>/install.sh \
  | ALLOY_REF=<full-commit-sha> bash
```

Contributors should install from a clone:

```bash
git clone https://github.com/ccoussa717/alloy.git
cd alloy
npm ci
npm run tui:install
npm link
alloy --version
```

Contributors must use `npm ci`, not `npm install`, for the Pi/backend tree and
`npm run tui:install` for the Bun frontend tree. The two lock files govern
separate dependency graphs.

## Launch and CLI options

Launch Alloy from the repository you want it to inspect:

```bash
cd /path/to/project
alloy
```

The default interactive path is:

```text
Node launcher -> Bun 1.3.14 -> Solid/OpenTUI -> local Pi RPC child
```

The RPC child uses piped stdio and the current project directory. It is the same
Pi runtime that owns credentials, tools, policy, sessions, models, and
extensions. The frontend does not open a network listener.

During a run, the transcript shows tool calls, shell commands, partial or final
tool output, and completion/error state. An eight-cell activity scanner below
the composer distinguishes active work, compaction, and retry from the idle
`Ready` state. In automatic mode, it animates in local terminals and remains
static over SSH to avoid continuous remote redraws. Set
`ALLOY_ACTIVITY_ANIMATION=on`, `off`, or `auto` (the default) to override or use
automatic detection. Assistant Markdown uses OpenTUI syntax
highlighting for its built-in JavaScript and TypeScript parsers plus bundled
Bash, C, C++, Go, Java, Python, and Rust parsers. These parser assets are
available offline and verified against `tui/assets/parsers/manifest.json` during
release checks.

Print, JSON, explicit RPC, positional initial prompts, and `@file` arguments
bypass OpenTUI and run Pi directly. Positional prompt and file handoff remain on
the Pi renderer until OpenTUI owns an equivalent startup-input contract.
Useful Pi CLI flags pass through the Alloy launcher:

```bash
alloy --version
alloy --model anthropic/<model-id>
alloy --model openai-codex/<model-id>
alloy --model xai/<model-id>
alloy --thinking high
alloy --no-inject --list-models
```

To temporarily roll back only the renderer:

```bash
alloy --legacy-pi-ui
ALLOY_LEGACY_PI_UI=1 alloy
```

The legacy Pi UI is not the default or a parallel product surface.

## Authentication and providers

Pi owns provider authentication and stores credentials in
`~/.pi/agent/auth.json`. In the OpenTUI shell, `/login` supports OAuth only and
connects one selected provider at a time. Run it again for each additional
provider; `/login xai` selects the Grok route directly. Provider choices show
green `configured` or gray `not configured` status.
The OpenTUI command adapts Pi's native auth interaction; Pi owns OAuth exchange,
refresh, token rotation, locking, and persistence. `/doctor` and `/providers`
resolve configured hosted providers through Pi. Expired access tokens refresh
automatically, while a timeout or provider outage reports an unavailable check
instead of instructing the user to replace valid credentials. A definitively
rejected refresh authorization reports that the provider must be reconnected.
Because Pi's refresh may still be holding its credential lock after Alloy's
diagnostic timeout, wait for the check to finish or restart Alloy before retrying.
Sign-in URLs, instructions, and device codes remain visible throughout login
and in later prompts so they can be selected while entering the authorization
response. Device-code flows continue polling in the background after presenting
the code, leaving the command queue available; Alloy reports completion or
failure in the TUI. Use `/login-cancel [provider]` to stop a pending device-code
flow. `/model` refreshes the authenticated model catalog whenever the selector
opens, then groups available models by provider before model selection.
Alloy rejects secret prompts because RPC input is intentionally not masked;
enter API keys through environment variables or `~/.pi/agent/models.json`, not
the TUI.

| Route | Setup | Notes |
|---|---|---|
| Anthropic subscription | `/login` | OAuth route for Claude Pro/Max. |
| ChatGPT/Codex subscription | `/login` | OAuth route; models use the `openai-codex/...` prefix. |
| Grok subscription | `/login xai` | OAuth/subscription route when exposed by Pi's provider runtime. |
| Anthropic API | `ANTHROPIC_API_KEY` | API provider route. |
| OpenAI API | `OPENAI_API_KEY` | Models use the `openai/...` prefix, not `openai-codex/...`. |
| xAI API | `XAI_API_KEY` | API provider route. |

### Local engines (auto-discovery)

Alloy probes these engines during extension load, before Pi resolves the initial
model, when `providers.local.enabled` is true (default). **Keyless loopback is
the supported default** - no API keys are required for local engines on
`127.0.0.1` / `localhost`.

| Provider | Default URL | Env |
|---|---|---|
| `ollama` | `http://127.0.0.1:11434` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST`; optional `OLLAMA_API_KEY` and `OLLAMA_CONTEXT_LENGTH` |
| `llama.cpp-local` | `http://127.0.0.1:8080` | `LLAMA_CPP_BASE_URL`, then `LLAMA_BASE_URL`; optional `LLAMA_CPP_API_KEY`, then `LLAMA_API_KEY` |
| `lm-studio` | `http://127.0.0.1:1234/v1` | `LM_STUDIO_BASE_URL`; optional `LM_STUDIO_API_KEY` |

Ollama does not expose its server-wide default context length through its model
catalog API. If the Ollama server sets `OLLAMA_CONTEXT_LENGTH`, export the same
value in Alloy's environment so models without an explicit Modelfile `num_ctx`
are reported accurately, then restart Alloy to refresh its startup catalog. An
explicit `num_ctx` still takes precedence. When Alloy targets a remote Ollama
server, set or unset the client variable to match that server rather than a
different local service.

Context resolution uses explicit model `num_ctx`, then `OLLAMA_CONTEXT_LENGTH`,
then architecture metadata, and finally Alloy's 128,000-token discovery default.

For Ollama models that report thinking support, Alloy sends `/thinking off` as
`reasoning_effort: "none"` and passes `low`, `medium`, and `high` through to
Ollama. Unmapped standard levels such as `minimal` also pass through unchanged;
whether they work depends on the selected Ollama model and server. Other
local-engine providers retain conservative reasoning defaults.

No OAuth. Optional keys apply to discovery and inference without being printed.
For keyless engines, Alloy's internal configuration marker is never sent as an
`Authorization` header. When an API-key environment variable is set, inference
sends that exact value as a bearer token.
Models appear under `/model` and `--list-models` when the engine was reachable
and had usable models at startup (llama.cpp: loaded models when status is
advertised). Start engines before Alloy, or restart Alloy after `ollama pull` or
a llama model load. Pi's native `llama.cpp` id and `/llama` command remain
separate; Alloy uses `llama.cpp-local` to avoid replacing Pi's provider runtime.
`/doctor` re-probes local reachability and model counts without mutating the
active session catalog. Hosted-provider checks may persist a refreshed OAuth
credential through Pi's native auth store.

Disable all probes with `"providers": { "local": { "enabled": false } }`.
Removing a local provider id from `providers.allow` disables its probe and hides
its auto-discovered catalog. Alloy automatically recognizes its exact generated
0.8.2 hosted-only allowlist and enables `ollama`, `llama.cpp-local`, and
`lm-studio` after upgrade. Customized allowlists and configs with explicit
`providers.local` settings remain authoritative. Discovered local engines
(`ollama`, `llama.cpp-local`, `lm-studio`) are eligible for `/model` and for
child orchestration (`/fission`, `/fusion`, `/auto`, `/agent`) when present in
the session registry: session credential leases treat them as trusted `local`
transports (OpenAI-compatible API, HTTP(S) base URL). Arbitrary custom
providers and modified hosted-transport overrides remain excluded.
Disabling discovery restores any provider and models defined manually in
`~/.pi/agent/models.json`; Alloy does not erase operator-managed catalogs.

Base URL normalization accepts HTTP(S) path prefixes, removes a terminal `/v1`
before native Ollama/llama probes, and strips URL userinfo, query strings, and
fragments. Put credentials in the API-key environment variables above, never in
endpoint URLs.

Each engine receives one aggregate probe deadline. Discovery reads at most 4 MiB
per response and publishes at most 512 models per engine. Ollama metadata
enrichment stops issuing requests when the engine deadline expires; remaining
catalog entries use a 128,000-token context window and 32,768-token output cap.

Use `/providers` for a short status report and `/doctor` for versions, provider
status, model defaults, economics, Docker, and paths. Neither command prints
secret values or makes a live model call. Green status means local credential or
configuration evidence passed Alloy's checks. `/model` confirms model
discoverability; an actual prompt confirms end-to-end authentication. `/whoami`
reports model identity from harness state rather than asking the model to
identify itself.

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
| `/providers` | Show hosted routes and local engine reachability, URLs, and model counts. |
| `/whoami` | Show authoritative harness and model identity. |
| `/honesty` | Show the active evidence and non-invention policy. |
| `/help [topic]` | Open the topic picker or browse Alloy documentation directly. |
| `/help search <query>` | Search all help topics. |
| `/help commands` | Render the complete active OpenTUI and Alloy backend command registry. |
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
| `/chrome` | Clear Alloy's custom Pi renderer chrome until restart (`--legacy-pi-ui` only). |

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
earlier. During the run, OpenTUI renders Architect and Builder side by side at
normal widths, including visible model output and read-tool activity, then adds
the Synthesizer below them. At 40-column or 10-row dimensions, the panel reduces
to a four-row summary so the composer remains usable. The final attributed
result remains in transcript scrollback; non-OpenTUI RPC hosts retain the
string-line widget fallback.

Auto attempts a checkpoint when running in a Git repository, prefers a worktree,
and runs up to `budgets.maxFixRounds` fix rounds after diagnostic or review
failure. Checkpoint failure is recorded but does not stop the subsequent build.
Auto records run metadata, patches, and raw diagnostic output under the Alloy
home directory. Treat run artifacts as operator data because repository scripts
control their output and can print sensitive text.

## OpenTUI command boundary

The OpenTUI shell implements a bounded command surface rather than claiming all
commands from Pi's former interactive renderer.

Frontend-local controls issue typed Pi RPC requests:

| Command | Purpose |
|---|---|
| `/new` | Start a new Pi session and refresh frontend state. |
| `/clone` | Clone the current Pi session and refresh frontend state. |
| `/compact [instructions]` | Compact the current Pi context. |
| `/session` | Show Pi session statistics. |
| `/export` | Export the current session to HTML and show the result. |
| `/model [provider/model]` | Open the local model selector or set a validated model. |
| `/thinking [level]` | Open the local selector or set Pi reasoning effort. |
| `/sidebar` | Toggle the responsive workspace sidebar. |
| `/quit`, `/exit`, `/q` | Close the frontend and its Pi child. |

Pi renderer commands needed by the new shell are supplied as RPC-compatible
extensions:

| Command | Purpose |
|---|---|
| `/resume` | Select a session from this project or all projects. |
| `/tree` | Navigate the current Pi session tree. |
| `/fork` | Fork from a prior user message. |
| `/reload` | Reload extensions, skills, prompts, themes, and context. |
| `/name [name]` | Set the current session name. |
| `/hotkeys` | Show OpenTUI keyboard shortcuts. |
| `/help [topic]` | Browse and search Alloy help, including the active command catalog. |
| `/login [provider]` | Complete a Pi-backed OAuth login. API-key entry is unavailable in OpenTUI. |
| `/login-cancel [provider]` | Cancel an active device-code OAuth login. |
| `/logout [provider]` | Remove and verify removal of a stored Pi credential. |

Recognized Alloy extension commands execute through Pi's RPC prompt command path,
including while a model is streaming. Recognized prompt-template and skill
commands expand in Pi before their resulting prompts are queued with steer
behavior during streaming. Their use of `select`, `confirm`, `input`, `editor`,
notifications, status, widgets, title, and editor text is bridged into OpenTUI.
`/help commands` combines the shared OpenTUI controls with the live Pi backend
registry, but it is not a claim that unsupported OpenCode workspace, server, or
plugin commands exist. Pi-native commands that depend on its legacy renderer
are omitted from the OpenTUI catalog.

The workspace sidebar appears automatically above 120 columns and can be
toggled at any width with `/sidebar`. Retained workflow panels remain visible
without disabling slash autocomplete. On an empty session, the shell points to
`/` for command completion and `/help` for guides.

Drag across rendered text with the mouse to select it. Releasing the mouse
copies a non-empty selection to the terminal clipboard through OSC 52. Pasting
into the composer uses the terminal's normal bracketed-paste path.

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

The global operator controls subsystem startup in `~/.pi/alloy/config.json`:

```json
{
  "mcp": {
    "enabled": true,
    "connectOnStart": false
  }
}
```

`mcp.enabled: false` blocks both automatic and explicit connections. A trusted
project may tighten this setting to `false`, but an untrusted project is
ignored and no project may enable `connectOnStart`. When the global operator
enables `connectOnStart`, Alloy connects only enabled global server entries;
project entries still require `/mcp connect` and cannot shadow a same-name
global startup server. Auto-connected tools are registered before the first
prompt in OpenTUI/RPC and print/headless sessions.

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
    },
    "reviewed-remote-with-query": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp?user_id=operator",
      "allowQuery": true,
      "enabled": false
    }
  }
}
```

Supported transports are stdio, Streamable HTTP, and legacy SSE. Use exact,
reviewed executables for stdio servers; avoid floating `npx -y <package>`
commands. Non-loopback HTTP and SSE servers must use HTTPS.
Remote URLs containing reviewed, non-secret query parameters must set
`"allowQuery": true`; URL fragments and embedded credentials are always rejected.

Put expanded header secrets in `~/.pi/alloy/env` with mode `0600`; never commit
them. MCP tool names use a sanitized, length-bounded
`mcp_<server>_<tool>_<hash>` form. Run `/mcp tools` for the exact callable name.
MCP tools default to the `external_side_effect` capability, so they require
approval under `ask-dangerous`.

## Filesystem layout

```text
~/.local/bin/alloy              absolute-Node Alloy wrapper
~/.local/share/alloy/
  app/                          installed source and exact dependencies
  node-v22.19.0-<platform>/     managed Node runtime when bootstrap is needed
  bun-v1.3.14-<platform>/       checksum-verified OpenTUI runtime

<alloy source or app>/tui/
  bun.lock                     frozen frontend dependency graph
  node_modules/                installed production frontend dependencies

~/.config/alloy/
  env                           Bash/Zsh PATH setup generated by the installer

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

The wrapper invokes the selected Node executable directly. A bootstrapped Node
runtime therefore does not replace the shell's default `node`; the generated
environment only puts the Alloy command directory first on `PATH`.

Supported path overrides:

| Variable | Purpose |
|---|---|
| `ALLOY_HOME` | Override `~/.pi/alloy`. |
| `PI_CODING_AGENT_DIR` | Override `~/.pi/agent`. |
| `ALLOY_PI_BIN` | Override the Pi executable used for child processes. |
| `ALLOY_BUN_BIN` | Override Bun; it must report exactly `1.3.14`. |
| `ALLOY_LEGACY_PI_UI` | Set to `1` to use the rollback Pi renderer for interactive sessions. |

Installer location overrides:

| Variable | Purpose |
|---|---|
| `ALLOY_PREFIX` | Override the command prefix; defaults to `~/.local`. |
| `XDG_DATA_HOME` | Relocate the installed app and managed Node directory. |

Installer path overrides must resolve to absolute paths. The generated Alloy
environment file must be a regular file, not a symlink.

The launcher exports `ALLOY_ROOT` to child processes as the resolved installed
package root. It is runtime information, not a supported user override.

## Troubleshooting

### A provider is missing, unavailable, or out of quota

Run `/doctor`. Pi refreshes expired OAuth credentials automatically. Use `/login`
or `/login xai` only when the route is missing or Pi rejects the stored
authorization. If the check is unavailable, retry it without replacing the
credential. Provider quota or extra-usage errors require waiting for the quota
window or changing the provider plan; signing in again does not fix them.
API keys do not authenticate `openai-codex/...`; that route uses ChatGPT/Codex
subscription authentication.

### Sandbox will not enable

Run `/sandbox doctor`. The Docker CLI and daemon must both be available. Alloy
does not fall back to host Bash when sandbox is required.

### Fusion is not ready

Run `/fusion status`, connect the required providers, then run `/fusion setup`.
All three roles need configured, authenticated model routes.

### Project configuration is ignored

Run `alloy --legacy-pi-ui`, use `/trust`, and restart the session. Project configuration is ignored until
the repository is trusted. Overrides to constrained approval, sandbox, MCP, and
budget fields that weaken global policy remain rejected after trust; trusted
workflow profiles and preferences are not restricted to tighten-only changes.

### MCP tools do not appear

Check `/mcp status`, confirm the server is enabled, then run `/mcp connect`.
Use `/mcp tools` to inspect registered names. Confirm `mcp.enabled` is true in
the effective configuration. Keep `connectOnStart` disabled until every global
server is trusted; project servers never auto-connect.

### A checkpoint cannot restore

`/undo` requires an interactive confirmation and a compatible repository state.
Use `/checkpoints` to identify the snapshot. Checkpoints are not remote backups.

### Alloy cannot find its bundled Pi CLI

Rerun the one-command installer. For a contributor clone, run `npm ci`,
`npm run tui:install`, and relink with `npm link`. Alloy
prefers the Pi dependency bundled with its own
installation, then searches global npm roots, prefix locations, and `PATH` as
recovery fallbacks. A global `pi update` does not change Alloy while its bundled
pinned runtime resolves, but it can affect a fallback installation.

### OpenTUI will not start

For a managed install, rerun the installer; it repairs the recorded Bun runtime
and frozen frontend dependency tree. If `alloy` is not found after installation,
restart Bash or Zsh, add `~/.local/bin` to `PATH`, or run
`~/.local/bin/alloy` directly.

For a contributor clone, run `bun --version` and require exactly `1.3.14`, then
run `npm ci`, `npm run tui:install`, and `npm link`. Use `--legacy-pi-ui` only as
a temporary renderer rollback while diagnosing the OpenTUI failure.

## Verification

Run the local verification bundle:

```bash
npm run ci:local
```

This requires `tmux` and runs unit and integration tests, frontend typechecking and Bun tests, the
live OpenTUI PTY suite, version and package checks, release metadata
verification, the security scan, and CycloneDX SBOM generation. It does not run
the high-severity publication audit from `npm run ci:release`.
Docker integration skips locally when Docker is unavailable; GitHub Actions
sets `ALLOY_REQUIRE_DOCKER_TEST=1`, so hosted release verification cannot pass
without it.

For security boundaries and residual risks, read [SECURITY.md](SECURITY.md).
