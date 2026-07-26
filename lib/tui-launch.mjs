import { join } from "node:path";

const DIRECT_PI_FLAGS = ["--mode", "--list-models", "--export"];
const VALUE_OPTIONS = new Set([
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
]);

function hasDirectPiOperation(args) {
  return args.some(
    (arg) =>
      arg === "-p" ||
      arg === "--print" ||
      DIRECT_PI_FLAGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
  );
}

function hasInitialPromptInput(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) {
      index++;
      continue;
    }
    if (arg === "--") return index + 1 < args.length;
    if (arg.startsWith("@") || !arg.startsWith("-")) return true;
  }
  return false;
}

export function selectInteractiveFrontend({ args, isTTY, env }) {
  if (!isTTY) return "pi";
  if (env.ALLOY_LEGACY_PI_UI === "1") return "pi";
  if (args.includes("--legacy-pi-ui")) return "pi";
  if (hasDirectPiOperation(args)) return "pi";
  // OpenTUI has no native initial-prompt handoff yet. Keep prompts and @files
  // on Pi's interactive renderer rather than silently dropping user input.
  if (hasInitialPromptInput(args)) return "pi";
  return "opentui";
}

export function shouldSuppressTerminalClear(args) {
  return hasDirectPiOperation(args) || args.includes("--version");
}

export function stripLegacyUiFlag(args) {
  return args.filter((arg) => arg !== "--legacy-pi-ui");
}

export function buildOpenTuiLaunch({
  alloyRoot,
  bunBin,
  nodeBin,
  piBin,
  piArgs,
  cwd,
  version,
  env,
}) {
  const isNodeEntry = piBin.endsWith(".js") || piBin.endsWith(".mjs");
  const rpcCommand = isNodeEntry ? nodeBin : piBin;
  const rpcArgs = isNodeEntry
    ? [piBin, "--mode", "rpc", ...piArgs]
    : ["--mode", "rpc", ...piArgs];
  const tuiRoot = join(alloyRoot, "tui");

  return {
    command: bunBin,
    args: ["--preload", "@opentui/solid/preload", join(tuiRoot, "src", "index.tsx")],
    cwd: tuiRoot,
    env: {
      ...env,
      ALLOY_ROOT: alloyRoot,
      ALLOY_VERSION: version,
      ALLOY_FRONTEND: "opentui",
      ALLOY_RPC_COMMAND: rpcCommand,
      ALLOY_RPC_ARGS_JSON: JSON.stringify(rpcArgs),
      ALLOY_RPC_CWD: cwd,
      PI_SKIP_VERSION_CHECK: env.PI_SKIP_VERSION_CHECK || "1",
    },
  };
}
