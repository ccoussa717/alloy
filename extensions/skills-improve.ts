/**
 * Skill creation + self-improve (approve before write).
 * Skills using skills is primarily model+prompt guidance + the skill-capture skill.
 *
 * Commands:
 *   /skill-capture <name> — draft a skill from recent work (or blank template)
 *   /skill-promote <draft-id> — approve and install draft into ~/.pi/agent/skills
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getSkillDraftsDir, getUserSkillsDir } = require(
  join(root, "lib", "paths.mjs"),
);

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "skill"
  );
}

function skillTemplate(name: string, description: string, body: string) {
  return `---
name: ${name}
description: ${description}
---

# ${name}

${body.trim()}

## Composition

When this skill needs a sub-capability, load another skill with \`read\` on its SKILL.md
or invoke \`/skill:other-skill\`. Do not recurse deeper than 3 skill levels.

## Self-improve

If you discover a better procedure while using this skill, propose an update with
\`/skill-capture ${name}-improved\` and wait for human approval before overwriting.
`;
}

export function registerSkillsImprove(pi: ExtensionAPI) {
  pi.registerCommand("skill-capture", {
    description:
      "Draft a new skill (approve later with /skill-promote): /skill-capture <name> [description]",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      if (!raw) {
        ctx.ui.notify(
          "Usage: /skill-capture <name> [optional description of the workflow]",
          "warning",
        );
        return;
      }
      const parts = raw.split(/\s+/);
      const name = slugify(parts[0]);
      const description =
        parts.slice(1).join(" ") ||
        `Captured skill: ${name}. Refine after promote.`;

      // Pull a bit of recent session context if available (best-effort)
      let sessionHint = "";
      try {
        const branch = ctx.sessionManager.getBranch?.() || [];
        const recent = branch
          .filter((e: { type?: string }) => e.type === "message")
          .slice(-6);
        if (recent.length) {
          sessionHint =
            "\n## Notes from capture session\n\n" +
            "Review and rewrite these into durable steps. Drop secrets.\n\n" +
            "_(Session context was present at capture time; edit freely.)_\n";
        }
      } catch {
        // ignore
      }

      const body = `## When to use

Use this skill when the user asks about: ${description}

## Steps

1. Restate the goal.
2. Load any related skills you need (compose, do not reinvent).
3. Perform the work with repository tools.
4. Verify with tests or a checklist.
5. Summarize what changed.

${sessionHint}`;

      const draftsDir = getSkillDraftsDir();
      mkdirSync(draftsDir, { recursive: true, mode: 0o700 });
      const draftPath = join(draftsDir, `${name}.md`);
      writeFileSync(draftPath, skillTemplate(name, description, body), {
        encoding: "utf8",
        mode: 0o600,
      });

      ctx.ui.notify(
        `Draft skill written: ${draftPath}\nReview, then /skill-promote ${name}`,
        "info",
      );

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Promote now?",
          `Install draft "${name}" into user skills now?`,
        );
        if (ok) {
          await promoteDraft(name, ctx);
        }
      }
    },
  });

  pi.registerCommand("skill-promote", {
    description: "Approve a draft skill and install it: /skill-promote <name>",
    handler: async (args, ctx) => {
      const name = slugify((args || "").trim());
      if (!name) {
        ctx.ui.notify("Usage: /skill-promote <draft-name>", "warning");
        return;
      }
      await promoteDraft(name, ctx);
    },
  });

  pi.registerCommand("skill-drafts", {
    description: "List skill drafts awaiting approval",
    handler: async (_args, ctx) => {
      const dir = getSkillDraftsDir();
      if (!existsSync(dir)) {
        ctx.ui.notify("No drafts directory yet.", "info");
        return;
      }
      const files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
      if (!files.length) {
        ctx.ui.notify("No skill drafts. Use /skill-capture <name>.", "info");
        return;
      }
      await ctx.ui.select("Skill drafts", files);
    },
  });
}

async function promoteDraft(
  name: string,
  ctx: {
    ui: {
      notify: (m: string, l?: string) => void;
      confirm?: (t: string, m: string) => Promise<boolean>;
    };
    hasUI?: boolean;
  },
) {
  const draftPath = join(getSkillDraftsDir(), `${name}.md`);
  if (!existsSync(draftPath)) {
    ctx.ui.notify(`No draft named "${name}" at ${draftPath}`, "warning");
    return;
  }

  if (ctx.hasUI && ctx.ui.confirm) {
    const ok = await ctx.ui.confirm(
      "Approve skill install",
      `Install skill "${name}" to user skills?\nThis is the self-improve approval gate.`,
    );
    if (!ok) {
      ctx.ui.notify("Promote cancelled.", "info");
      return;
    }
  }

  const content = readFileSync(draftPath, "utf8");
  const destDir = join(getUserSkillsDir(), name);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const dest = join(destDir, "SKILL.md");

  if (existsSync(dest) && ctx.hasUI && ctx.ui.confirm) {
    const overwrite = await ctx.ui.confirm(
      "Overwrite?",
      `Skill ${name} already exists. Overwrite SKILL.md?`,
    );
    if (!overwrite) {
      ctx.ui.notify("Promote cancelled (exists).", "info");
      return;
    }
  }

  writeFileSync(dest, content, { encoding: "utf8", mode: 0o600 });
  ctx.ui.notify(
    `Promoted skill → ${dest}\nReload with /reload or restart. Invoke: /skill:${name}`,
    "info",
  );
}
