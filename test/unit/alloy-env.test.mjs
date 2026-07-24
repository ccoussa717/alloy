import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectAlloyEnvFile } from "../../lib/alloy-env.mjs";

const temp = mkdtempSync(join(tmpdir(), "alloy-env-test-"));

after(() => rmSync(temp, { recursive: true, force: true }));

test("accepts an owned regular secrets file with mode 0600", () => {
  const path = join(temp, "safe.env");
  writeFileSync(path, "MCP_TOKEN=test\n", { mode: 0o600 });
  chmodSync(path, 0o600);

  assert.deepEqual(inspectAlloyEnvFile(path), { ok: true });
});

test("rejects secrets files readable by group or other users", () => {
  const path = join(temp, "open.env");
  writeFileSync(path, "MCP_TOKEN=test\n", { mode: 0o644 });
  chmodSync(path, 0o644);

  assert.match(inspectAlloyEnvFile(path).reason, /0600|permissions/i);
});

test("rejects a symlinked secrets file", () => {
  const target = join(temp, "target.env");
  const path = join(temp, "linked.env");
  writeFileSync(target, "MCP_TOKEN=test\n", { mode: 0o600 });
  symlinkSync(target, path);

  assert.match(inspectAlloyEnvFile(path).reason, /symlink/i);
});
