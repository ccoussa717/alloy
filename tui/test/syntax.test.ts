import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addDefaultParsers, getTreeSitterClient } from "@opentui/core";
import parsers from "../src/parsers-config";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
addDefaultParsers(parsers.parsers);

describe("syntax parser coverage", () => {
  it("registers OpenCode-compatible parsers for requested programming languages", () => {
    const filetypes = new Set(parsers.parsers.map((parser) => parser.filetype));
    expect(filetypes).toEqual(new Set(["bash", "c", "cpp", "go", "java", "python", "rust"]));
  });

  it("uses bundled parser assets and verifies every file against the release manifest", () => {
    const manifest = JSON.parse(readFileSync(join(root, "assets/parsers/manifest.json"), "utf8")) as {
      schemaVersion: number;
      parsers: Record<string, { assets: Record<string, string> }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    for (const parser of parsers.parsers) {
      expect(parser.wasm).toBe(join(root, `assets/parsers/${parser.filetype}/parser.wasm`));
      expect(parser.queries.highlights).toContain(join(root, `assets/parsers/${parser.filetype}/highlights.scm`));
      for (const query of parser.queries.highlights) {
        expect(query.startsWith(join(root, "assets/parsers"))).toBe(true);
      }
      const entry = manifest.parsers[parser.filetype];
      expect(entry).toBeDefined();
      for (const [name, expected] of Object.entries(entry!.assets)) {
        const actual = createHash("sha256").update(readFileSync(join(root, `assets/parsers/${parser.filetype}/${name}`))).digest("hex");
        expect(actual).toBe(expected);
      }
    }
  });

  it("loads each bundled parser and produces real highlights", async () => {
    const samples: Record<string, string> = {
      bash: "if test -f file; then echo ok; fi",
      c: "int main(void) { return 0; }",
      cpp: "int main() { return 0; }",
      go: "package main\nfunc main() {}",
      java: "class Main { public static void main(String[] args) {} }",
      python: "def greet(name: str):\n    return f\"hello {name}\"",
      rust: "fn main() { println!(\"hello\"); }",
    };
    const client = getTreeSitterClient();
    try {
      for (const [filetype, source] of Object.entries(samples)) {
        const result = await client.highlightOnce(source, filetype);
        expect(result.error).toBeUndefined();
        expect(result.warning).toBeUndefined();
        expect(result.highlights?.length).toBeGreaterThan(0);
      }
      const rustConstant = await client.highlightOnce("const ALL_CAPS: i32 = 1;", "rust");
      expect(rustConstant.highlights?.some(([, , capture]) => capture === "constant")).toBe(true);
      expect(rustConstant.highlights?.some(([, , capture]) => capture === "constructor")).toBe(false);
    } finally {
      await client.destroy();
    }
  });
});
