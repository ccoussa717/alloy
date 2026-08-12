import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommandHistory,
  loadCommandHistoryFile,
  saveCommandHistoryFile,
} from "../src/command-history";

describe("command history", () => {
  it("pushes entries and walks up/down like readline", () => {
    const history = createCommandHistory({ limit: 10 });
    history.push("/fission review");
    history.push("/help");
    history.push("/fission status");

    expect(history.previous("")).toBe("/fission status");
    expect(history.previous("")).toBe("/help");
    expect(history.previous("")).toBe("/fission review");
    expect(history.previous("")).toBe("/fission review"); // clamp at oldest

    expect(history.next("")).toBe("/help");
    expect(history.next("")).toBe("/fission status");
    expect(history.next("")).toBe(""); // back to draft
    expect(history.next("")).toBe(null);
  });

  it("preserves in-progress draft when browsing history", () => {
    const history = createCommandHistory();
    history.push("/old");
    expect(history.previous("half typed")).toBe("/old");
    expect(history.next("ignored")).toBe("half typed");
  });

  it("skips empty and consecutive duplicates", () => {
    const history = createCommandHistory();
    history.push("   ");
    history.push("/a");
    history.push("/a");
    history.push("/b");
    expect(history.entries()).toEqual(["/a", "/b"]);
  });

  it("caps length", () => {
    const history = createCommandHistory({ limit: 3 });
    history.push("1");
    history.push("2");
    history.push("3");
    history.push("4");
    expect(history.entries()).toEqual(["2", "3", "4"]);
  });

  it("persists to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "alloy-hist-"));
    const path = join(dir, "command-history.json");
    try {
      saveCommandHistoryFile(path, ["/one", "/two"]);
      expect(loadCommandHistoryFile(path)).toEqual(["/one", "/two"]);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.entries).toEqual(["/one", "/two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
