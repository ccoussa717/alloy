/**
 * Alloy + Pi version reporting (single source of truth).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot, readPackageVersion } from "./pi-package.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function getAlloyVersion() {
  if (process.env.ALLOY_VERSION) return String(process.env.ALLOY_VERSION);
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function getPiVersion() {
  return readPackageVersion(
    findPackageRoot("@earendil-works/pi-coding-agent", [root]),
  );
}

export function getNodeVersionInfo() {
  const raw = process.versions.node;
  const parts = raw.split(".").map((n) => Number(n));
  return {
    raw: `v${raw}`,
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  };
}

/** Alloy requires Node >= 22.19.0 (Pi peer requirement). */
export const NODE_MIN = { major: 22, minor: 19, patch: 0 };

export function nodeMeetsMinimum(info = getNodeVersionInfo(), min = NODE_MIN) {
  if (info.major > min.major) return true;
  if (info.major < min.major) return false;
  if (info.minor > min.minor) return true;
  if (info.minor < min.minor) return false;
  return info.patch >= min.patch;
}

export function formatVersionBlock() {
  const alloy = getAlloyVersion();
  const pi = getPiVersion();
  const node = getNodeVersionInfo();
  const nodeOk = nodeMeetsMinimum(node);
  return [
    `Alloy ${alloy}`,
    `Pi    ${pi || "(not found)"}`,
    `Node  ${node.raw}${nodeOk ? "" : "  ⚠ below required >=22.19.0"}`,
  ].join("\n");
}
