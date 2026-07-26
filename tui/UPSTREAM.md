# Upstream Provenance

This frontend ports the OpenCode 1.18.4 Solid/OpenTUI interaction model and
visual structure into Alloy while retaining Alloy's Pi runtime behind RPC.

- OpenCode source commit: `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`
- OpenTUI 0.4.5 source commit: `0c8c4f7cff2927e3df63a9757a45eff9a343611c`
- `@opentui/core`, `@opentui/keymap`, and `@opentui/solid`: 0.4.5
- `solid-js`: 1.9.12 with OpenCode's transition fix upstreamed
- Activity scanner, transcript tool-state, and Markdown syntax behavior follow
  OpenCode's `component/prompt/index.tsx`, `routes/session/index.tsx`, and
  `ui/spinner.ts` at the pinned source commit.
- Extended Tree-sitter parsers are bundled from the versions and repositories
  recorded in `assets/parsers/manifest.json`. Each entry pins the release URL,
  release WASM URL, immutable source commit, and asset hashes; exact licenses
  are stored beside each asset. The manifest also records Alloy's one local
  Rust highlight-query correction.

Sources:

- https://github.com/anomalyco/opencode/tree/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/tui
- https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/LICENSE
- https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/patches/solid-js%401.9.10.patch
- https://github.com/sst/opentui/tree/0c8c4f7cff2927e3df63a9757a45eff9a343611c
