---
name: skill-capture
description: Turn a successful workflow into a durable skill draft. Always require human approval before promoting.
---

# skill-capture

## When to use

Use when the user says a workflow should become a skill, or after a multi-step task worth reusing.

## Steps

1. Summarize the goal, inputs, tools used, and verification steps.
2. Strip secrets, credentials, personal data, and one-off paths.
3. Note any skills this should compose with (skills using skills).
4. Create a draft with `/skill-capture <name> <description>`.
5. Show the draft path and wait for `/skill-promote <name>` approval.
6. Never overwrite an existing skill without explicit approval.

## Composition depth

Max 3 levels of skill composition. If deeper, flatten into one skill.

## Self-improve rule

Propose → show → human approves → promote. Silent skill mutation is forbidden.
