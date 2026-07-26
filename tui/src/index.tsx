import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { AlloyApp } from "./app";
import { RpcClient, type RpcMessage } from "./rpc-client";
import { createInitialState, reduceRpcMessage, type SessionState } from "./session-store";
import { theme } from "./theme";

function rpcConfig() {
  const command = process.env.ALLOY_RPC_COMMAND;
  if (!command) throw new Error("ALLOY_RPC_COMMAND is required");

  let args: string[] = [];
  const encodedArgs = process.env.ALLOY_RPC_ARGS_JSON;
  if (encodedArgs) {
    const value: unknown = JSON.parse(encodedArgs);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error("ALLOY_RPC_ARGS_JSON must be a JSON array of strings");
    }
    args = value;
  }
  return { command, args, cwd: process.env.ALLOY_RPC_CWD || undefined };
}

async function main(): Promise<number> {
  let renderer: CliRenderer | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopMessages: (() => void) | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const pending: RpcMessage[] = [];
  let listener: ((message: RpcMessage) => void) | undefined;
  let finished = false;
  let finishCode = 0;
  let resolveFinished!: (code: number) => void;
  const finishedPromise = new Promise<number>((resolve) => (resolveFinished = resolve));
  const client = new RpcClient(rpcConfig());

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    finishCode = code;
    if (renderer && !renderer.isDestroyed) renderer.destroy();
    resolveFinished(code);
  };

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    const handler = () => {
      finish(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
      void client.stop();
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    stopMessages = client.onMessage((message) => {
      if (listener) listener(message);
      else pending.push(message);
    });
    await client.start();

    let initial: SessionState = createInitialState();
    const hydration = await Promise.all(
      ["get_state", "get_messages", "get_commands", "get_available_models", "get_session_stats"].map((type) =>
        client.request({ type }),
      ),
    );
    for (const response of hydration) initial = reduceRpcMessage(initial, response);
    for (const message of pending.splice(0)) initial = reduceRpcMessage(initial, message);

    renderer = await createCliRenderer({
      externalOutputMode: "passthrough",
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
      useMouse: true,
      backgroundColor: theme.background,
      consoleOptions: { keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }] },
    });
    renderer.setBackgroundColor(theme.background);
    renderer.once("destroy", () => finish(finishCode));

    const subscribe = (next: (message: RpcMessage) => void): (() => void) => {
      listener = next;
      for (const message of pending.splice(0)) next(message);
      return () => {
        if (listener === next) listener = undefined;
      };
    };

    await render(
      () => (
        <AlloyApp
          client={client}
          initialState={initial}
          version={process.env.ALLOY_VERSION || "dev"}
          subscribe={subscribe}
          onExit={finish}
        />
      ),
      renderer,
    );

    let probing = false;
    heartbeat = setInterval(() => {
      if (probing || finished) return;
      probing = true;
      void client.request({ type: "get_state" }, { observational: true, timeoutMs: 5_000 }).then(
        (response) => {
          probing = false;
          listener?.(response);
        },
        (error) => {
          probing = false;
          const message = error instanceof Error ? error.message : String(error);
          listener?.({ type: "fatal_error", error: `Backend disconnected: ${message}` });
          setTimeout(() => finish(1), 100);
        },
      );
    }, 2_000);

    return await finishedPromise;
  } catch (error) {
    if (finished) return finishCode;
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    stopMessages?.();
    await client.stop();
    if (renderer && !renderer.isDestroyed) {
      renderer.setTerminalTitle("");
      renderer.destroy();
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`Alloy TUI: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
