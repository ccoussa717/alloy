---
name: git-hygiene
description: Safe git workflow — status, diff review, commits, and branch discipline without force-pushing protected history.
---

# git-hygiene

## When to use

Use for commits, branch setup, or pre-push checks.

## Steps

1. `git status` and `git diff` — know what will change.
2. Do not commit secrets (`.env`, keys, auth.json).
3. Write a clear commit message (complete sentences).
4. Avoid `git push --force` and `reset --hard` unless the user explicitly requests it.
5. Prefer small, reviewable commits.

## Composition

After code changes, use `/skill:testing` before declaring done.

## Alloy policy note

Force-push and `reset --hard` trigger Alloy safe-mode approval.
