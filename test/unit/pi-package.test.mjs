import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findPackageRoot,
  findPiCli,
  findPiRuntime,
  readPackageVersion,
} from "../../lib/pi-package.mjs";

const temp = mkdtempSync(join(tmpdir(), "alloy-pi-package-"));

after(() => rmSync(temp, { recursive: true, force: true }));

function fakePackage(root, name, version, files = []) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
}

test("finds Pi when npm hoists it beside the installed Alloy package", () => {
  const alloyRoot = join(temp, "hoisted", "node_modules", "alloy-agent");
  const piRoot = join(
    temp,
    "hoisted",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  mkdirSync(alloyRoot, { recursive: true });
  fakePackage(piRoot, "@earendil-works/pi-coding-agent", "0.82.0", [
    "dist/cli.js",
  ]);

  assert.equal(
    findPackageRoot("@earendil-works/pi-coding-agent", [alloyRoot]),
    piRoot,
  );
  assert.equal(findPiCli([alloyRoot]), join(piRoot, "dist", "cli.js"));
  assert.deepEqual(findPiRuntime([alloyRoot]), {
    packageRoot: piRoot,
    cli: join(piRoot, "dist", "cli.js"),
    nodeModulesRoot: join(temp, "hoisted", "node_modules"),
  });
  assert.equal(readPackageVersion(piRoot), "0.82.0");
});

test("prefers a nested Pi dependency and validates the package identity", () => {
  const alloyRoot = join(temp, "nested", "alloy-agent");
  const wrongRoot = join(
    alloyRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  fakePackage(wrongRoot, "not-pi", "9.9.9", ["dist/cli.js"]);

  assert.equal(
    findPackageRoot("@earendil-works/pi-coding-agent", [alloyRoot]),
    null,
  );
  assert.equal(findPiCli([alloyRoot]), null);
});
