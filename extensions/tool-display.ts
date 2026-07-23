/**
 * Compact tool display — informational one-liners like Grok Build.
 *
 * Collapsed (default): tool name + short target, result = ✓/✗ summary.
 * Expanded (Ctrl+O / tools expanded): more detail from built-in renderers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { isSandboxProfile, setSandboxActive } = require(
  join(root, "lib", "state.mjs"),
);
const {
  ensureSandboxContainer,
  createDockerBashOperations,
} = require(join(root, "lib", "docker-sandbox.mjs"));

type ThemeLike = {
  fg: (c: string, t: string) => string;
  bold?: (t: string) => string;
};

function oneLine(s: string, max = 88): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function shortPath(p: string, cwd?: string): string {
  if (!p) return "";
  let s = p;
  if (cwd && s.startsWith(cwd)) {
    s = s.slice(cwd.length).replace(/^\//, "") || ".";
  }
  if (s.length > 56) {
    const base = basename(s);
    return `…/${base}`;
  }
  return s;
}

function resultText(result: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (!result?.content) return "";
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n")
    .trim();
}

function line(
  theme: ThemeLike,
  name: string,
  detail: string,
  accent = "toolTitle",
): InstanceType<typeof Text> {
  const label = theme.bold
    ? theme.bold(theme.fg(accent, name))
    : theme.fg(accent, name);
  const rest = detail ? theme.fg("dim", `  ${oneLine(detail)}`) : "";
  return new Text(label + rest, 0, 0);
}

function summaryResult(
  theme: ThemeLike,
  result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean },
  context: { expanded?: boolean; isError?: boolean },
  builtInRender?: () => unknown,
): InstanceType<typeof Text> | unknown {
  if (context.expanded && builtInRender) {
    try {
      return builtInRender();
    } catch {
      // fall through to compact
    }
  }
  const err = Boolean(context.isError || result?.isError);
  const raw = resultText(result);
  if (!raw) {
    return new Text(
      theme.fg(err ? "error" : "dim", err ? "  ✗ failed" : "  ✓ done"),
      0,
      0,
    );
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (!context.expanded) {
    if (lines.length === 1 && lines[0]!.length <= 96) {
      return new Text(
        theme.fg(err ? "error" : "muted", `  ${err ? "✗" : "✓"} ${oneLine(lines[0]!, 90)}`),
        0,
        0,
      );
    }
    return new Text(
      theme.fg(
        err ? "error" : "muted",
        `  ${err ? "✗" : "✓"} ${lines.length} line${lines.length === 1 ? "" : "s"}`,
      ),
      0,
      0,
    );
  }
  // Expanded: cap at 12 lines still (Ctrl+O for full dump via built-in if available)
  const body = lines.slice(0, 12).join("\n");
  const more =
    lines.length > 12
      ? theme.fg("dim", `\n  … +${lines.length - 12} more`)
      : "";
  return new Text(
    theme.fg(err ? "error" : "toolOutput", `  ${body}`) + more,
    0,
    0,
  );
}

/**
 * Apply compact display overrides for built-in tools.
 * Must run after sandbox registration so bash keeps Docker routing.
 */
export function registerToolDisplay(pi: ExtensionAPI) {
  const cwd = process.cwd();

  const read = createReadTool(cwd);
  pi.registerTool({
    ...read,
    label: "read",
    renderCall(args: { path?: string; offset?: number; limit?: number }, theme, context) {
      if (context.expanded && read.renderCall) {
        return read.renderCall(args, theme, context);
      }
      const p = shortPath(String(args?.path || ""), context.cwd || cwd);
      const range =
        args?.offset != null
          ? `:${args.offset}${args.limit != null ? `+${args.limit}` : ""}`
          : "";
      return line(theme as ThemeLike, "read", p + range);
    },
    renderResult(result, options, theme, context) {
      return summaryResult(theme as ThemeLike, result, context, () =>
        read.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });

  const write = createWriteTool(cwd);
  pi.registerTool({
    ...write,
    label: "write",
    renderCall(args: { path?: string; content?: string }, theme, context) {
      if (context.expanded && write.renderCall) {
        return write.renderCall(args, theme, context);
      }
      const p = shortPath(String(args?.path || ""), context.cwd || cwd);
      const n = String(args?.content || "").length;
      return line(theme as ThemeLike, "write", `${p}  ${n}b`);
    },
    renderResult(result, options, theme, context) {
      return summaryResult(theme as ThemeLike, result, context, () =>
        write.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });

  const edit = createEditTool(cwd);
  pi.registerTool({
    ...edit,
    label: "edit",
    renderShell: "default", // drop heavy self-shell diff UI unless expanded
    renderCall(args: { path?: string }, theme, context) {
      if (context.expanded && edit.renderCall) {
        return edit.renderCall(args, theme, context);
      }
      const p = shortPath(String(args?.path || ""), context.cwd || cwd);
      return line(theme as ThemeLike, "edit", p);
    },
    renderResult(result, options, theme, context) {
      if (context.expanded && edit.renderResult) {
        try {
          return edit.renderResult(result, options, theme, context);
        } catch {
          // compact
        }
      }
      return summaryResult(theme as ThemeLike, result, context) as InstanceType<
        typeof Text
      >;
    },
  });

  const grep = createGrepTool(cwd);
  pi.registerTool({
    ...grep,
    label: "grep",
    renderCall(
      args: { pattern?: string; path?: string; glob?: string },
      theme,
      context,
    ) {
      if (context.expanded && grep.renderCall) {
        return grep.renderCall(args, theme, context);
      }
      const pat = oneLine(String(args?.pattern || ""), 40);
      const p = shortPath(String(args?.path || args?.glob || "."), context.cwd || cwd);
      return line(theme as ThemeLike, "grep", `${pat}  ${p}`);
    },
    renderResult(result, options, theme, context) {
      return summaryResult(theme as ThemeLike, result, context, () =>
        grep.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });

  const find = createFindTool(cwd);
  pi.registerTool({
    ...find,
    label: "find",
    renderCall(args: { pattern?: string; path?: string }, theme, context) {
      if (context.expanded && find.renderCall) {
        return find.renderCall(args, theme, context);
      }
      const pat = oneLine(String(args?.pattern || ""), 40);
      const p = shortPath(String(args?.path || "."), context.cwd || cwd);
      return line(theme as ThemeLike, "find", `${pat}  ${p}`);
    },
    renderResult(result, options, theme, context) {
      return summaryResult(theme as ThemeLike, result, context, () =>
        find.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });

  const ls = createLsTool(cwd);
  pi.registerTool({
    ...ls,
    label: "ls",
    renderCall(args: { path?: string }, theme, context) {
      if (context.expanded && ls.renderCall) {
        return ls.renderCall(args, theme, context);
      }
      const p = shortPath(String(args?.path || "."), context.cwd || cwd);
      return line(theme as ThemeLike, "ls", p);
    },
    renderResult(result, options, theme, context) {
      return summaryResult(theme as ThemeLike, result, context, () =>
        ls.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });

  // bash last: preserve Alloy sandbox routing
  const hostBash = createBashTool(cwd);
  pi.registerTool({
    ...hostBash,
    label: "bash",
    description:
      hostBash.description +
      " When Alloy permission profile is sandbox, commands run in Docker (network none).",
    async execute(id, params, signal, onUpdate, ctx) {
      if (!isSandboxProfile()) {
        return hostBash.execute(id, params, signal, onUpdate);
      }
      try {
        const info = ensureSandboxContainer(process.cwd());
        setSandboxActive(true, info.name);
        try {
          ctx?.ui?.setStatus?.(
            "alloy-sandbox",
            ctx.ui.theme?.fg
              ? ctx.ui.theme.fg("accent", `sbx:${info.name.slice(-8)}`)
              : `sandbox`,
          );
        } catch {
          // ignore
        }
        const sandboxed = createBashTool(process.cwd(), {
          operations: createDockerBashOperations(process.cwd()),
        });
        return sandboxed.execute(id, params, signal, onUpdate);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Sandbox bash failed: ${(err as Error).message || err}`,
            },
          ],
          details: { error: true },
        };
      }
    },
    renderCall(args: { command?: string; timeout?: number }, theme, context) {
      const cmd = oneLine(String(args?.command || ""), 72);
      const sbx = isSandboxProfile() ? theme.fg("accent", "sbx ") : "";
      const label = theme.bold
        ? theme.bold(theme.fg("toolTitle", "bash"))
        : theme.fg("toolTitle", "bash");
      return new Text(
        `${label}  ${sbx}${theme.fg("dim", cmd ? `$ ${cmd}` : "$ …")}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      // Streaming partial: stay quiet unless expanded
      if (options.isPartial && !context.expanded) {
        return new Text(theme.fg("dim", "  …"), 0, 0);
      }
      return summaryResult(theme as ThemeLike, result, context, () =>
        hostBash.renderResult?.(result, options, theme, context),
      ) as InstanceType<typeof Text>;
    },
  });
}

/** Compact render helpers for Alloy-registered tools (MCP, etc.). */
export function compactToolRenderers(toolName: string) {
  return {
    renderCall(
      args: Record<string, unknown>,
      theme: ThemeLike,
      _context: { expanded?: boolean },
    ) {
      // Prefer a short arg snapshot
      let detail = "";
      for (const key of ["path", "command", "query", "pattern", "name", "text", "request"]) {
        if (args?.[key] != null && String(args[key]).trim()) {
          detail = oneLine(String(args[key]), 70);
          break;
        }
      }
      if (!detail) {
        try {
          detail = oneLine(JSON.stringify(args || {}), 50);
          if (detail === "{}" || detail === "null") detail = "";
        } catch {
          detail = "";
        }
      }
      return line(theme, toolName.replace(/^mcp_/, "").replace(/_/g, "·"), detail);
    },
    renderResult(
      result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean },
      _options: { isPartial?: boolean },
      theme: ThemeLike,
      context: { expanded?: boolean; isError?: boolean },
    ) {
      return summaryResult(theme, result, context) as InstanceType<typeof Text>;
    },
  };
}
