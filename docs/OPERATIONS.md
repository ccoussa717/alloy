# Alloy operations checklist

Use this checklist when installing Alloy as a daily coding-agent shell.

## Install

The npm package is not published. Install the public source and bundled Pi
runtime without `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/ccoussa717/alloy/main/install.sh | bash
```

- [ ] The installer reuses Node.js 22.19+ or installs and checksum-verifies
  Node.js 22.19.0.
- [ ] Restart Bash or Zsh so the generated Alloy environment file is loaded.
  Other shells and symlinked dotfile setups must add `~/.local/bin` to `PATH`
  or invoke it directly.
- [ ] `alloy --version` prints Alloy, Pi, and Node versions.
- [ ] `alloy --list-models` starts the bundled Pi runtime with Alloy resources.
- [ ] The host is macOS or glibc-based Linux; Alpine and other musl-based Linux
  distributions are unsupported.

The normal command fetches a mutable installer from `main`, then resolves and
installs the latest stable GitHub release tag. Set `ALLOY_CHANNEL=main` for the
tip of `main`. Pin both the raw installer URL and `ALLOY_REF` to the same full
commit SHA when both must be immutable.
Contributors should use `npm ci && npm run tui:install && npm link` from a clone.
Do not use `npm install` because release dependencies are governed by
`npm-shrinkwrap.json` and `tui/bun.lock`.

## Provider setup

- [ ] Run `/login` once for each hosted subscription provider you intend to use.
- [ ] For local models, start Ollama, llama.cpp, or LM Studio before Alloy; no
  login is required for keyless loopback servers.
- [ ] Run `/doctor`; it must resolve hosted credentials through Pi, refresh
  OAuth when needed, distinguish rejected authorization from temporary
  unavailability, and never expose secret values.
- [ ] Treat green `configured` as local evidence, then send a prompt to verify
  end-to-end authentication.
- [ ] Confirm `/whoami` reports harness facts rather than model guesses.

Pi owns provider authentication and stores credentials under
`~/.pi/agent/auth.json`.

## Safety posture

| Situation | Recommended mode |
|---|---|
| Normal work | `ask-dangerous` |
| Exploration or review | `plan` or `review` |
| Untrusted repository | `sandbox` with Docker |
| Trusted automation | Explicit operator decision; never implicit |

Host mode is not a filesystem jail. Docker provides the stronger boundary,
uses `network=none` by default, and fails closed when required but unavailable.
`/auto` also fails closed in sandbox mode because its repository diagnostics are
host processes rather than Docker-sandboxed Bash.

## MCP

- [ ] Keep global server config in `~/.pi/alloy/mcp.json`.
- [ ] Trust a project before loading project MCP configuration.
- [ ] Use exact, reviewed stdio server executables. Do not use floating
  `npx -y <package>` commands.
- [ ] Use HTTPS for every non-loopback remote MCP transport.
- [ ] Store expanded header secrets in `~/.pi/alloy/env` with mode `0600`.
- [ ] Leave `connectOnStart` disabled unless every enabled global server is
  trusted. Project servers never auto-connect.

## Recovery

- [ ] Exercise `/checkpoint` and `/undo` on disposable work before relying on it.
- [ ] Keep worktree and checkpoint stores under `~/.pi/alloy/` protected as
  operator data.
- [ ] Do not describe checkpoints as backups; push important work to a remote.

## Release verification

```bash
npm ci
npm run tui:install
npm run ci:local
bash scripts/run-swebench-release-smoke.sh test
```

Docker integration skips on machines without Docker. GitHub Actions sets
`ALLOY_REQUIRE_DOCKER_TEST=1`, so a release cannot pass without the sandbox
test.

See [SECURITY.md](./SECURITY.md), [BOUNDARY.md](./BOUNDARY.md), and
[RELEASING.md](./RELEASING.md).
