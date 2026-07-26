import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildOpenTuiLaunch,
  selectInteractiveFrontend,
  shouldSuppressTerminalClear,
} from "../../lib/tui-launch.mjs";

describe("OpenTUI launcher selection", () => {
  it("uses OpenTUI only for an interactive terminal without a direct Pi operation", () => {
    assert.equal(selectInteractiveFrontend({ args: [], isTTY: true, env: {} }), "opentui");
    assert.equal(selectInteractiveFrontend({ args: [], isTTY: false, env: {} }), "pi");
    assert.equal(selectInteractiveFrontend({ args: ["--legacy-pi-ui"], isTTY: true, env: {} }), "pi");
    assert.equal(selectInteractiveFrontend({ args: [], isTTY: true, env: { ALLOY_LEGACY_PI_UI: "1" } }), "pi");
  });

  it("routes noninteractive operations and their equals forms directly to Pi", () => {
    for (const args of [
      ["-p", "hello"],
      ["--print", "hello"],
      ["--mode", "rpc"],
      ["--mode=json"],
      ["--list-models"],
      ["--list-models", "anthropic"],
      ["--list-models=anthropic"],
      ["--export", "/tmp/session.jsonl"],
      ["--export=/tmp/session.jsonl"],
    ]) {
      assert.equal(
        selectInteractiveFrontend({ args, isTTY: true, env: {} }),
        "pi",
        args.join(" "),
      );
    }
  });

  it("routes positional prompts and @file inputs to legacy Pi interactive mode", () => {
    for (const args of [
      ["explain this repo"],
      ["@README.md"],
      ["--model", "anthropic/claude", "explain this repo"],
      ["--provider=anthropic", "@prompt.md"],
    ]) {
      assert.equal(
        selectInteractiveFrontend({ args, isTTY: true, env: {} }),
        "pi",
        args.join(" "),
      );
    }
  });

  it("does not mistake known option values for positional prompts", () => {
    for (const args of [
      ["--provider", "anthropic"],
      ["--model", "anthropic/claude-sonnet"],
      ["--session", "/tmp/session.jsonl"],
      ["--session-id", "session-id"],
      ["--session-dir", "/tmp/sessions"],
      ["--fork", "/tmp/session.jsonl"],
      ["--models", "anthropic/*"],
      ["--system-prompt", "Be concise"],
      ["--append-system-prompt", "@system.md"],
      ["--model=anthropic/claude-sonnet"],
    ]) {
      assert.equal(
        selectInteractiveFrontend({ args, isTTY: true, env: {} }),
        "opentui",
        args.join(" "),
      );
    }
  });

  it("suppresses terminal clearing for every direct noninteractive form", () => {
    for (const args of [
      ["-p"],
      ["--print"],
      ["--mode", "text"],
      ["--mode=json"],
      ["--list-models=anthropic"],
      ["--export=session.jsonl"],
    ]) {
      assert.equal(shouldSuppressTerminalClear(args), true, args.join(" "));
    }
    assert.equal(shouldSuppressTerminalClear(["--model", "anthropic/claude"]), false);
  });

  it("builds a Bun frontend launch that starts Pi in RPC mode", () => {
    const launch = buildOpenTuiLaunch({
      alloyRoot: "/opt/alloy",
      bunBin: "/opt/bun/bin/bun",
      nodeBin: "/opt/node/bin/node",
      piBin: "/opt/alloy/node_modules/pi/dist/cli.js",
      piArgs: ["-e", "/opt/alloy/extensions/index.ts", "--model", "anthropic/test"],
      cwd: "/work/project",
      version: "0.8.2",
      env: { HOME: "/home/test" },
    });

    assert.equal(launch.command, "/opt/bun/bin/bun");
    assert.deepEqual(launch.args, [
      "--preload",
      "@opentui/solid/preload",
      "/opt/alloy/tui/src/index.tsx",
    ]);
    assert.equal(launch.cwd, "/opt/alloy/tui");
    assert.equal(launch.env.ALLOY_RPC_COMMAND, "/opt/node/bin/node");
    assert.deepEqual(JSON.parse(launch.env.ALLOY_RPC_ARGS_JSON), [
      "/opt/alloy/node_modules/pi/dist/cli.js",
      "--mode",
      "rpc",
      "-e",
      "/opt/alloy/extensions/index.ts",
      "--model",
      "anthropic/test",
    ]);
    assert.equal(launch.env.ALLOY_RPC_CWD, "/work/project");
    assert.equal(launch.env.ALLOY_VERSION, "0.8.2");
    assert.equal(launch.env.ALLOY_FRONTEND, "opentui");
  });

  it("starts an executable Pi backend directly", () => {
    const launch = buildOpenTuiLaunch({
      alloyRoot: "/opt/alloy",
      bunBin: "bun",
      nodeBin: "node",
      piBin: "/usr/local/bin/pi",
      piArgs: ["--no-session"],
      cwd: "/work",
      version: "dev",
      env: {},
    });

    assert.equal(launch.env.ALLOY_RPC_COMMAND, "/usr/local/bin/pi");
    assert.deepEqual(JSON.parse(launch.env.ALLOY_RPC_ARGS_JSON), ["--mode", "rpc", "--no-session"]);
  });
});
