# OpenCode TUI Migration Implementation Record

## Status

Implemented in the current source. Alloy's default interactive renderer is an
adapted OpenCode 1.18.4 Solid/OpenTUI shell. Pi remains the backend and
authoritative runtime.

This is an Alloy adaptation of MIT-licensed upstream work, not the complete
OpenCode application and not an endorsement by OpenCode or its contributors.

## Final Architecture

```text
interactive TTY
  Node launcher
    -> Bun 1.3.14
      -> Solid 1.9.12 + OpenTUI 0.4.5
        -> strict local JSON-lines RPC over stdio
          -> Pi RPC child + Alloy extensions

print / JSON / explicit RPC
  Node launcher -> Pi directly

temporary renderer rollback
  --legacy-pi-ui or ALLOY_LEGACY_PI_UI=1 -> Pi interactive renderer
```

Pi still owns provider and model runtimes, OAuth and credential storage, tools,
policy, sessions, compaction, extensions, MCP, memory, sandboxing, and child
workflows. The frontend owns terminal rendering, local selectors, and the
extension UI presentation bridge. It does not duplicate policy or credentials.

The frontend starts one Pi child with piped stdio. Startup requires a successful
`get_state` response. RPC requests have IDs; explicitly observational requests
may time out, while mutations wait for an authoritative response. Stderr is
bounded and redacted before display. Malformed records and correlated response
mismatches are fatal, backend loss is fatal, and shutdown escalates from
`SIGTERM` to `SIGKILL` after a bounded wait. No TCP server, Unix socket, or remote
UI endpoint was added.

## Implemented Surface

- OpenTUI transcript, sticky scrolling, composer, selection, responsive layout,
  tool rows, notifications, widgets, status, terminal title, and modal dialogs.
- Pi state hydration for messages, session state, commands, models, and usage.
- Prompt, steer, abort, compaction, new session, export, model selection,
  thinking level, streaming events, tool events, and backend failure handling.
- Extension UI bridge for `select`, `confirm`, `input`, `editor`, `notify`,
  `setStatus`, `setWidget`, `setTitle`, and editor text.
- RPC-compatible `/resume`, `/tree`, `/fork`, `/reload`, `/name`, `/hotkeys`,
  `/login`, and `/logout` commands.
- Frontend-local `/new`, `/compact`, `/session`, `/export`, `/model`,
  `/thinking`, `/help`, and exit commands backed by Pi RPC where applicable.
- OAuth-only OpenTUI login through Pi's model runtime. Secret prompts are
  rejected because API-key input is intentionally not unmasked; API-key routes
  continue through environment variables or supported Pi configuration.
- Node launcher selection for OpenTUI, direct Pi modes, and the explicit legacy
  renderer rollback.
- Installer support for checksum-verified Bun 1.3.14 on Linux and macOS x64 and
  arm64, plus frozen TUI production dependency installation.
- OpenCode, OpenTUI, and Solid license notices, source commits, and versioned
  provenance under `tui/`.

## Provenance

| Component | Version | Source |
|---|---|---|
| OpenCode interaction architecture | `1.18.4` | commit `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e` |
| OpenTUI core, keymap, and Solid renderer | `0.4.5` | commit `0c8c4f7cff2927e3df63a9757a45eff9a343611c` |
| Solid | `1.9.12` | OpenCode transition fix is upstream; patch retained as provenance only |
| Bun | `1.3.14` | exact runtime required and installer-pinned |

The implementation ports the needed shell structure and interaction model into
Alloy's own frontend and Pi adapter. It does not claim OpenCode's SDK, server,
workspace model, plugin host, or unsupported commands.

## Observed Verification

Linux x64 glibc is the live-tested platform.

- Real tmux PTYs launched at 80x24 and 40x10 with transcript hydration,
  composer, sticky-tail scrolling, wheel pause/resume, resize, and selection.
- Prompt and streaming events, compact tool display, Shift+Tab mode submission,
  extension confirmation/cancellation, abort, idle exit, backend loss, and
  terminal restoration were exercised through the frontend RPC client.
- Ctrl-C, pre-readiness SIGTERM/SIGINT, outer-launcher SIGTERM, and backend-loss
  paths cleaned up descendants and restored terminal modes; backend loss exited
  nonzero.
- Frontend unit tests cover RPC lifecycle, reducers, content rendering, command
  routing, and layout state. Node tests cover launcher selection, native command
  adapters, OAuth command behavior, and installer behavior.
- The source installer installed the exact npm tree and frozen TUI production
  tree, then resolved the bundled Pi runtime and managed Bun path.
- Release audit passes at the high threshold after pinning patched root and TUI
  dependency resolutions; the no-fix moderate Hono advisory remains documented.
- Bun archive selection and pinned SHA-256 values are tested for Linux x64,
  Linux arm64, macOS x64, and macOS arm64. Those non-Linux-x64 artifacts are
  checksum-tested, not live UI-tested by Alloy.

## Remaining Limitations

- Live end-to-end evidence is limited to Linux x64 glibc. Other installer
  artifacts have checksum and selection coverage but no claimed live terminal
  verification.
- The old Pi renderer remains available as a temporary rollback. Maintaining it
  indefinitely is not a goal.
- OpenTUI command compatibility is intentionally bounded to the local and
  RPC-compatible commands documented above. No unsupported OpenCode workspace,
  server, SDK, or plugin features are claimed.
- API-key entry is unavailable in OpenTUI until a genuinely masked secret-input
  channel exists.
- The frontend runs from source with frozen dependencies. A single-file Bun
  executable remains rejected because the tested build did not embed OpenTUI's
  native shared library.
