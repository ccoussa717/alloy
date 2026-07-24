# Alloy operations checklist

Use this checklist when installing Alloy as a daily coding-agent shell.

## Install

The npm package is not published yet. The registry command below applies only
after the launch checklist in [RELEASING.md](./RELEASING.md) is complete.

- [ ] Node.js 22.19 or newer is installed.
- [ ] After launch, install an exact release: `npm install --global alloy-agent@<version>`.
- [ ] `alloy --version` prints Alloy, Pi, and Node versions.
- [ ] `alloy --no-inject --list-models` starts the bundled Pi runtime.

Contributors should use `npm ci && npm link` from a clone. Do not use
`npm install` because releases are governed by `npm-shrinkwrap.json`.

## Provider setup

- [ ] Run `/login` only for providers you intend to use.
- [ ] Run `/doctor`; it must report credential shape without secret values.
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

## MCP

- [ ] Keep global server config in `~/.pi/alloy/mcp.json`.
- [ ] Trust a project before loading project MCP configuration.
- [ ] Use exact, reviewed stdio server executables. Do not use floating
  `npx -y <package>` commands.
- [ ] Use HTTPS for every non-loopback remote MCP transport.
- [ ] Store expanded header secrets in `~/.pi/alloy/env` with mode `0600`.
- [ ] Leave `connectOnStart` disabled unless every configured server is trusted.

## Recovery

- [ ] Exercise `/checkpoint` and `/undo` on disposable work before relying on it.
- [ ] Keep worktree and checkpoint stores under `~/.pi/alloy/` protected as
  operator data.
- [ ] Do not describe checkpoints as backups; push important work to a remote.

## Release verification

```bash
npm ci
npm run ci:local
```

Docker integration skips on machines without Docker. Release CI sets
`ALLOY_REQUIRE_DOCKER_TEST=1`, so a release cannot pass without the sandbox
test.

See [SECURITY.md](./SECURITY.md), [BOUNDARY.md](./BOUNDARY.md), and
[RELEASING.md](./RELEASING.md).
