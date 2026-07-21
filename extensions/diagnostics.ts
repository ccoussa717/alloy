/**
 * Diagnostics: /diagnose and alloy_diagnostics tool
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { detectProject, planDiagnostics, runDiagnostics } = require(
  join(root, "lib", "diagnostics.mjs"),
);

export function registerDiagnostics(pi: ExtensionAPI) {
  pi.registerCommand("diagnose", {
    description: "Run project diagnostics (typecheck/lint/test when detected)",
    handler: async (args, ctx) => {
      const includeTests = !/\b--no-test\b/.test(args || "");
      ctx.ui.notify("Running diagnostics…", "info");
      const result = runDiagnostics(process.cwd(), { includeTests });
      const lines = [
        `stacks: ${(result.stacks || []).join(", ") || "(unknown)"}`,
        result.summary || "(no summary)",
        "",
        ...((result.results || []).map(
          (r: { name: string; ok: boolean; command: string }) =>
            `${r.ok ? "✓" : "✗"} ${r.name}: ${r.command}`,
        )),
      ];
      if (ctx.hasUI) await ctx.ui.select("Diagnostics", lines);
      else console.log(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "alloy_diagnostics",
    label: "Alloy Diagnostics",
    description:
      "Detect the project stack and run typecheck/lint/tests. Use after implementing changes.",
    promptSnippet: "Run project diagnostics",
    promptGuidelines: [
      "Prefer alloy_diagnostics after substantive code changes.",
      "Report failures with the command output to the user.",
    ],
    parameters: Type.Object({
      includeTests: Type.Optional(Type.Boolean({ default: true })),
      stopOnFail: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params) {
      const info = detectProject(process.cwd());
      const plan = planDiagnostics(process.cwd(), {
        includeTests: params.includeTests !== false,
      });
      const result = runDiagnostics(process.cwd(), {
        includeTests: params.includeTests !== false,
        stopOnFail: Boolean(params.stopOnFail),
      });
      const failures = (result.results || []).filter((r: { ok: boolean }) => !r.ok);
      const detail = failures
        .map(
          (r: { name: string; stderr: string; stdout: string }) =>
            `### ${r.name}\n${(r.stderr || r.stdout || "").slice(0, 4000)}`,
        )
        .join("\n\n");
      const text = [
        result.summary,
        "",
        `package: ${info.packageName || "(none)"}`,
        `planned steps: ${plan.steps.map((s: { name: string }) => s.name).join(", ") || "(none)"}`,
        detail ? `\n## Failures\n${detail}` : "",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
