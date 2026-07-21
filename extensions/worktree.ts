/**
 * Worktree commands for isolated builders.
 * /worktree create|list|remove|diff
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  createWorktree,
  listWorktrees,
  removeWorktree,
  worktreeDiff,
  isGitRepo,
} = require(join(root, "lib", "worktree.mjs"));

export function registerWorktree(pi: ExtensionAPI) {
  pi.registerCommand("worktree", {
    description: "Git worktrees: /worktree [create|list|remove|diff] …",
    handler: async (args, ctx) => {
      const parts = (args || "list").trim().split(/\s+/);
      const cmd = parts[0] || "list";
      try {
        if (!isGitRepo(process.cwd()) && cmd !== "list") {
          ctx.ui.notify("Not a git repository.", "warning");
          return;
        }

        if (cmd === "create") {
          const role = parts[1] || "builder";
          const taskId = parts[2] || undefined;
          const wt = createWorktree({ role, taskId, cwd: process.cwd() });
          ctx.ui.notify(
            `Worktree ${wt.id}\npath: ${wt.path}\nbranch: ${wt.branch}`,
            "info",
          );
          return;
        }

        if (cmd === "list") {
          const list = listWorktrees(process.cwd());
          if (!list.length) {
            ctx.ui.notify("No Alloy worktrees. /worktree create [role] [taskId]", "info");
            return;
          }
          const items = list.map(
            (w: { id: string; branch: string; exists: boolean; path: string }) =>
              `${w.exists ? "●" : "○"} ${w.id}  ${w.branch}  ${w.path}`,
          );
          await ctx.ui.select(`Worktrees (${list.length})`, items);
          return;
        }

        if (cmd === "remove") {
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("Usage: /worktree remove <id>", "warning");
            return;
          }
          if (ctx.hasUI) {
            const ok = await ctx.ui.confirm("Remove worktree?", `Remove ${id}?`);
            if (!ok) return;
          }
          const removed = removeWorktree(id, { cwd: process.cwd() });
          ctx.ui.notify(`Removed worktree ${removed.id}`, "info");
          return;
        }

        if (cmd === "diff") {
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("Usage: /worktree diff <id>", "warning");
            return;
          }
          const d = worktreeDiff(id, process.cwd());
          const preview = (d.stat || d.diff || "(empty)").split("\n").slice(0, 40);
          await ctx.ui.select(`Diff ${d.id}`, preview.length ? preview : ["(empty)"]);
          return;
        }

        ctx.ui.notify("Usage: /worktree create|list|remove|diff", "warning");
      } catch (err) {
        ctx.ui.notify(String((err as Error).message || err), "error");
      }
    },
  });

  pi.registerTool({
    name: "alloy_worktree",
    label: "Alloy Worktree",
    description:
      "Create, list, or inspect Alloy-managed git worktrees for isolated implementation work.",
    promptSnippet: "Manage isolated git worktrees",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("diff"),
        Type.Literal("remove"),
      ]),
      role: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        if (params.action === "create") {
          const wt = createWorktree({
            role: params.role || "builder",
            taskId: params.taskId,
            cwd: process.cwd(),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(wt, null, 2) }],
            details: wt,
          };
        }
        if (params.action === "list") {
          const list = listWorktrees(process.cwd());
          return {
            content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
            details: { list },
          };
        }
        if (params.action === "diff") {
          if (!params.id) throw new Error("id required");
          const d = worktreeDiff(params.id, process.cwd());
          return {
            content: [
              {
                type: "text",
                text: `${d.stat || ""}\n\n${(d.diff || "").slice(0, 20_000)}`,
              },
            ],
            details: { id: d.id, branch: d.branch },
          };
        }
        if (params.action === "remove") {
          if (!params.id) throw new Error("id required");
          const removed = removeWorktree(params.id, { cwd: process.cwd() });
          return {
            content: [{ type: "text", text: `Removed ${removed.id}` }],
            details: removed,
          };
        }
        throw new Error("unknown action");
      } catch (err) {
        return {
          content: [{ type: "text", text: String((err as Error).message || err) }],
          details: { error: true },
        };
      }
    },
  });
}
