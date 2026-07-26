import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = mkdtempSync(join(tmpdir(), "alloy-launcher-signals-"));
const fakePi = join(temp, "fake-pi.mjs");

writeFileSync(
  fakePi,
  `const signal = process.env.ALLOY_TEST_SIGNAL;
if (process.env.ALLOY_TEST_CLEANUP === "1") {
  process.on(signal, () => {
    process.stdout.write(\`SIGNAL \${signal}\\n\`);
    setTimeout(() => {
      process.stdout.write("CLEANUP\\n");
      process.exit(23);
    }, 75);
  });
}
process.stdout.write(\`READY \${process.pid}\\n\`);
setInterval(() => {}, 1000);
`,
);

after(() => rmSync(temp, { recursive: true, force: true }));

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function exerciseSignal(signal, cleanup = true) {
  const home = join(temp, `${signal.toLowerCase()}-${cleanup}`);
  mkdirSync(home, { recursive: true });
  const launcher = spawn(
    process.execPath,
    [join(root, "bin", "alloy.mjs"), "--list-models"],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        ALLOY_HOME: join(home, ".pi", "alloy"),
        ALLOY_NO_CLEAR: "1",
        ALLOY_PI_BIN: fakePi,
        ALLOY_TEST_SIGNAL: signal,
        ALLOY_TEST_CLEANUP: cleanup ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let stderr = "";
  let childPid;
  launcher.stdout.setEncoding("utf8");
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise((resolve) => {
    launcher.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (match && childPid === undefined) {
        childPid = Number(match[1]);
        resolve();
      }
    });
  });
  const closed = new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code, exitSignal) => resolve({ code, exitSignal }));
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${signal} test timed out: ${stderr || output}`)),
      10_000,
    );
    timeoutId.unref();
  });

  try {
    await Promise.race([ready, timeout]);
    assert.equal(launcher.kill(signal), true);
    const result = await Promise.race([closed, timeout]);
    if (cleanup) {
      assert.deepEqual(result, { code: null, exitSignal: signal });
      assert.match(output, new RegExp(`SIGNAL ${signal}\\nCLEANUP\\n`));
    } else {
      assert.deepEqual(result, { code: null, exitSignal: signal });
    }
    assert.equal(isRunning(childPid), false, `child ${childPid} was orphaned`);
  } finally {
    clearTimeout(timeoutId);
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
    }
    if (childPid && isRunning(childPid)) process.kill(childPid, "SIGKILL");
  }
}

describe("integration: launcher signal forwarding", { skip: process.platform === "win32" }, () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    it(`forwards ${signal}, waits for cleanup, and preserves the termination signal`, async () => {
      await exerciseSignal(signal);
    });
  }

  it("removes handlers before mirroring a child termination signal", async () => {
    await exerciseSignal("SIGTERM", false);
  });
});
