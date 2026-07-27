# Contributing to Alloy

Thank you for improving Alloy. Contributions should preserve its role as a
provider-neutral product layer on Pi and keep operator safety explicit.

## Before starting

- Search existing issues and pull requests before opening a duplicate.
- Discuss large behavior, dependency, security-boundary, or CLI changes before
  implementation.
- Never include credentials, private prompts, customer data, or internal
  infrastructure details.
- Report vulnerabilities privately according to [SECURITY.md](./SECURITY.md).

## Development setup

Requirements: Node.js 22.19 or newer, Bun 1.3.14, npm, Git, and `tmux`.
Docker is optional locally and required by CI.

```bash
npm ci
bun install --cwd tui --frozen-lockfile
npm link
alloy --version
```

Use `npm ci`, not `npm install`. The release-included shrinkwrap is part of
Alloy's supply-chain contract.

## Make a change

1. Create a focused branch.
2. Add a failing test for behavior changes.
3. Make the smallest change that passes the test.
4. Update user-facing and security documentation when behavior changes.
5. Run the complete local gate.

```bash
npm run ci:local
```

Docker tests skip locally when Docker is absent. Say so in the pull request;
GitHub Actions requires them.

## Pull requests

Include:

- the problem and user impact;
- the chosen approach and alternatives considered;
- security or compatibility implications;
- commands run and observed results; and
- documentation changes.

Keep pull requests reviewable. Maintainers may ask to split unrelated changes.
All commits must include a Developer Certificate of Origin sign-off using
`git commit -s`.

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](./LICENSE).

## Design rules

- Do not vendor Pi source. Changes to the public Alloy Pi fork must stay within
  viewport, transcript navigation, standard user-message presentation, and
  bounded structured RPC state needed by the Alloy frontend.
- Use Pi for provider authentication.
- Do not log credential values.
- Project configuration may not weaken operator policy.
- MCP tools share the native capability gate.
- Self-improving skills require explicit human promotion.
- Describe host mode honestly; it is not a filesystem sandbox.
