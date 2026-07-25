---
name: testing
description: Run and interpret project tests. Prefer targeted tests for the change; escalate to full suite when needed.
---

# testing

## When to use

Use when the user asks to test, verify, or check that a change works.

## Steps

1. Detect the stack (package.json scripts, pytest, cargo test, go test, etc.).
2. Prefer the smallest test set that covers the change.
3. Run tests; capture failures with file and assertion context.
4. Fix only if the user asked for fixes; otherwise report clearly.
5. Re-run until green or blocked.

## Composition

If release packaging is also in scope, load `/skill:git-hygiene` before pushing.

## Do not

- Skip failing tests without saying so.
- Commit unless the user asked.
