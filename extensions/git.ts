/**
 * Git checkpoints for recoverability.
 * /checkpoint [label]  /checkpoints  /undo [id]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  isGitRepo,
} = require(join(root, "lib", "git-checkpoint.mjs"));

export function registerGit(pi: ExtensionAPI) {
  pi.registerCommand("checkpoint", {
    description: "Create a git checkpoint: /checkpoint [label]",
    handler: async (args, ctx) => {
      try {
        if (!isGitRepo(process.cwd())) {
          ctx.ui.notify("Not a git repository.", "warning");
          return;
        }
        const cp = createCheckpoint((args || "").trim(), process.cwd());
        ctx.ui.notify(
          `Checkpoint ${cp.id}${cp.ref ? "" : " (clean tree)"}\n${cp.label}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      }
    },
  });

  pi.registerCommand("checkpoints", {
    description: "List recent git checkpoints",
    handler: async (_args, ctx) => {
      try {
        const list = listCheckpoints(process.cwd()).slice(0, 30);
        if (!list.length) {
          ctx.ui.notify("No checkpoints yet. Use /checkpoint [label].", "info");
          return;
        }
        const items = list.map(
          (c: { id: string; label: string; created: string; dirty: boolean }) =>
            `${c.id}  ${c.created.slice(0, 19)}  ${c.dirty ? "dirty" : "clean"}  ${c.label}`,
        );
        await ctx.ui.select("Checkpoints", items);
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      }
    },
  });

  pi.registerCommand("undo", {
    description: "Restore a checkpoint (destructive): /undo [id]",
    handler: async (args, ctx) => {
      try {
        if (!isGitRepo(process.cwd())) {
          ctx.ui.notify("Not a git repository.", "warning");
          return;
        }
        const list = listCheckpoints(process.cwd());
        if (!list.length) {
          ctx.ui.notify("No checkpoints to restore.", "warning");
          return;
        }

        let id = (args || "").trim();
        if (!id && ctx.hasUI) {
          const items = list
            .slice(0, 20)
            .map(
              (c: { id: string; label: string; created: string }) =>
                `${c.id}  ${c.created.slice(0, 19)}  ${c.label}`,
            );
          const picked = await ctx.ui.select("Restore which checkpoint?", items);
          if (!picked) return;
          id = picked.split(/\s+/)[0];
        }
        if (!id) {
          ctx.ui.notify("Usage: /undo <checkpoint-id>", "warning");
          return;
        }

        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Headless /undo denied (fail-closed). Use interactive UI.",
            "warning",
          );
          return;
        }

        const ok = await ctx.ui.confirm(
          "Restore checkpoint?",
          `This can overwrite working tree changes.\nRestore ${id}?`,
        );
        if (!ok) {
          ctx.ui.notify("Restore cancelled.", "info");
          return;
        }

        const restored = restoreCheckpoint(id, process.cwd());
        ctx.ui.notify(`Restored checkpoint ${restored.id}`, "info");
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      }
    },
  });
}
