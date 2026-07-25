/**
 * Docker sandbox profile: bash runs inside node:22-bookworm, network none.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  diagnoseDocker,
  formatDockerDoctor,
  ensureSandboxContainer,
  stopSandboxContainer,
  createDockerBashOperations,
  getSandboxConfig,
} = require(join(root, "lib", "docker-sandbox.mjs"));
const {
  getState,
  setPermissionProfile,
  setSandboxActive,
  isSandboxProfile,
} = require(join(root, "lib", "state.mjs"));

export function registerSandbox(pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const hostBash = createBashTool(localCwd);

  // Override built-in bash: host by default, Docker when profile is sandbox
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
              ? ctx.ui.theme.fg("accent", `🔒 sbx:${info.name.slice(-8)}`)
              : `🔒 sandbox`,
          );
        } catch {
          // ignore UI
        }
        const sandboxed = createBashTool(process.cwd(), {
          operations: createDockerBashOperations(process.cwd()) as BashOperations,
        });
        return sandboxed.execute(id, params, signal, onUpdate);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Sandbox bash failed: ${(err as Error).message || err}\nFix Docker or /permissions safe`,
            },
          ],
          details: { error: true },
        };
      }
    },
  });

  // !shell / user bash path — fail closed when sandbox profile is on but Docker
  // is unavailable (never fall back to host bash).
  pi.on("user_bash", () => {
    if (!isSandboxProfile()) return;
    try {
      const info = ensureSandboxContainer(process.cwd());
      setSandboxActive(true, info.name);
      return {
        operations: createDockerBashOperations(process.cwd()) as BashOperations,
      };
    } catch (err) {
      const reason = String((err as Error)?.message || err || "Docker unavailable");
      return {
        operations: {
          async exec(_command: string, _cwd: string, _opts: unknown) {
            throw new Error(
              `Sandbox bash denied (host bash blocked): ${reason}`,
            );
          },
        } as BashOperations,
      };
    }
  });

  pi.registerCommand("sandbox", {
    description: "Docker sandbox: /sandbox [status|start|stop|doctor]",
    handler: async (args, ctx) => {
      const cmd = (args || "status").trim().split(/\s+/)[0] || "status";
      const d = diagnoseDocker(process.cwd());
      const cfg = getSandboxConfig(process.cwd());
      const profile = getState().permissionProfile;

      if (cmd === "doctor" || cmd === "status") {
        const lines = [
          ...formatDockerDoctor(d).split("\n"),
          "",
          `permission profile: ${profile}`,
          `sandbox active: ${getState().sandboxActive ? "yes" : "no"}`,
          `container: ${getState().sandboxContainer || "(none)"}`,
          "",
          "Enable: /permissions sandbox",
          "Network default is none (no egress).",
        ];
        if (ctx.hasUI) await ctx.ui.select("Alloy sandbox", lines);
        else console.log(lines.join("\n"));
        return;
      }

      if (cmd === "start") {
        try {
          if (!d.daemon) {
            ctx.ui.notify(`Cannot start: ${d.detail}`, "error");
            return;
          }
          setPermissionProfile("sandbox");
          const info = ensureSandboxContainer(process.cwd());
          setSandboxActive(true, info.name);
          ctx.ui.setStatus(
            "alloy-sandbox",
            ctx.ui.theme?.fg
              ? ctx.ui.theme.fg("accent", `🔒 sbx`)
              : "🔒 sandbox",
          );
          ctx.ui.setStatus("alloy-policy", "perm:sandbox");
          ctx.ui.notify(
            `Sandbox up: ${info.name}\nimage ${cfg.image} · network ${cfg.network}${info.pulled ? " · pulled image" : ""}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(String((err as Error).message || err), "error");
        }
        return;
      }

      if (cmd === "stop") {
        const stopped = stopSandboxContainer(process.cwd());
        if (!stopped.stopped) {
          ctx.ui.notify(`Sandbox stop failed: ${stopped.error}`, "error");
          return;
        }
        setSandboxActive(false, null);
        ctx.ui.setStatus("alloy-sandbox", undefined);
        ctx.ui.notify("Sandbox container stopped.", "info");
        return;
      }

      ctx.ui.notify("Usage: /sandbox status|start|stop|doctor", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const d = diagnoseDocker(process.cwd());
    if (isSandboxProfile()) {
      if (!d.daemon) {
        ctx.ui.notify(
          `Profile is sandbox but Docker unavailable: ${d.detail}. Use /permissions safe.`,
          "warning",
        );
        ctx.ui.setStatus("alloy-sandbox", "sbx:unavailable");
      } else {
        ctx.ui.setStatus(
          "alloy-sandbox",
          ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "🔒 sandbox") : "🔒 sandbox",
        );
      }
    }
  });

  pi.on("session_shutdown", () => {
    if (getState().sandboxActive) {
      const stopped = stopSandboxContainer(process.cwd());
      if (!stopped.stopped) {
        const message = `Sandbox shutdown cleanup failed: ${stopped.error}`;
        console.error(message);
        throw new Error(message);
      }
      setSandboxActive(false, null);
    }
  });
}
