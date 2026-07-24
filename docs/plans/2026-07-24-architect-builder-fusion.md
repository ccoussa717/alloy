# Architect-Builder Fusion Plan

Issue: KYL-279

## Goal

Replace Alloy's generic plan fusion with a bounded three-call workflow: a fresh
Architect and Builder produce independent read-only proposals in parallel, then
a fresh Synthesizer emits one attributed recommendation. Preserve Alloy's Pi
runtime, policy enforcement, run artifacts, and TUI rather than porting the
fusion-harness monolith.

## Constraints

- Exactly two proposal roles and at most one synthesis call; eligible successful
  runs make exactly three model calls while failures stop earlier.
- No implementation, parallel writers, validation loop, or Codex CLI adapter.
- Child credentials are provider-scoped ephemeral leases; secrets never enter
  run artifacts, prompts, logs, or the child environment.
- Parent approval and sandbox policy cannot be weakened.
- `COMPLETE` requires two valid proposals and one valid synthesis.

## Steps

1. Add failing tests for distinct role routing, parent-mode preservation,
   parallel dispatch, proposal validation, synthesis eligibility, truthful
   failure/abort/budget statuses, and credential selection.
2. Add a provider-scoped credential lease helper that reads only the selected
   entries from Pi `auth.json` or materializes selected API-key environment
   variables into an ephemeral auth payload.
3. Refactor `lib/fusion.mjs` around explicit Architect, Builder, and Synthesizer
   stages with structured Markdown contracts and exactly three calls on an
   eligible successful run.
4. Fix command/tool mode propagation, surface synthesis in the transcript and
   tool result, and update capability/config/help documentation.
5. Run focused tests, the exact Node 22.19 unit and integration suites,
   release verification, security scan, diff review, and an independent final
   review.

## Done

- `/fusion <objective>` dispatches two distinct configured models concurrently.
- Both proposal children are mechanically read-only and receive only selected
  ephemeral credentials.
- Synthesis is skipped unless both proposal contracts validate.
- Abort, auth, budget, malformed output, and synthesis failure are never
  reported as complete.
- The caller sees attributed synthesis, role/model identity, usage, status,
  and artifact location.
- Exact Node 22.19 verification passes with no must-fix review findings.
