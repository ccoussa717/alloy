/**
 * Composer command history (readline-style up/down).
 * Pure core + optional disk persistence under ~/.pi/alloy/.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_COMMAND_HISTORY_LIMIT = 200;

export type CommandHistory = {
  /** Snapshot of stored entries (oldest → newest). */
  entries(): string[];
  /** Browse index: 0..length-1 while walking history; length means live draft. */
  index(): number;
  /** Record a submitted command (trims, skips empties/dupes of last). */
  push(value: string): void;
  /** Move to older entry. Returns text to show, or null if none. */
  previous(current: string): string | null;
  /** Move to newer entry / draft. Returns text, or null if already at draft with no change. */
  next(current: string): string | null;
  /** Leave history browse mode after the user types. */
  abandonBrowse(): void;
};

function normalizeEntry(value: string): string {
  return String(value ?? "").replace(/\s+$/u, "");
}

function sanitizeEntries(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = normalizeEntry(item);
    if (!text.trim()) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.slice(-Math.max(1, limit));
}

export function createCommandHistory(options: {
  limit?: number;
  initial?: string[];
  onChange?: (entries: string[]) => void;
} = {}): CommandHistory {
  const limit = Math.max(1, options.limit ?? DEFAULT_COMMAND_HISTORY_LIMIT);
  let entries = sanitizeEntries(options.initial ?? [], limit);
  /** One past the last entry = editing a live draft. */
  let index = entries.length;
  let draft = "";

  const notify = () => options.onChange?.(entries.slice());

  return {
    entries: () => entries.slice(),
    index: () => index,
    push(value: string) {
      const text = normalizeEntry(value);
      if (!text.trim()) {
        index = entries.length;
        draft = "";
        return;
      }
      if (entries[entries.length - 1] === text) {
        index = entries.length;
        draft = "";
        return;
      }
      entries = [...entries, text].slice(-limit);
      index = entries.length;
      draft = "";
      notify();
    },
    previous(current: string) {
      if (entries.length === 0) return null;
      if (index >= entries.length) {
        draft = normalizeEntry(current);
        index = entries.length - 1;
        return entries[index] ?? null;
      }
      if (index <= 0) return entries[0] ?? null;
      index -= 1;
      return entries[index] ?? null;
    },
    next(current: string) {
      if (index >= entries.length) return null;
      index += 1;
      if (index >= entries.length) {
        index = entries.length;
        return draft;
      }
      return entries[index] ?? null;
    },
    abandonBrowse() {
      index = entries.length;
      draft = "";
    },
  };
}

export function defaultCommandHistoryPath(): string {
  const home = process.env.ALLOY_HOME || join(homedir(), ".pi", "alloy");
  return join(home, "command-history.json");
}

export function loadCommandHistoryFile(path: string, limit = DEFAULT_COMMAND_HISTORY_LIMIT): string[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.entries;
    return sanitizeEntries(list, limit);
  } catch {
    return [];
  }
}

export function saveCommandHistoryFile(path: string, entries: string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    // history is best-effort
  }
}

export function createPersistentCommandHistory(options: {
  path?: string;
  limit?: number;
} = {}): CommandHistory {
  const path = options.path || defaultCommandHistoryPath();
  const limit = options.limit ?? DEFAULT_COMMAND_HISTORY_LIMIT;
  return createCommandHistory({
    limit,
    initial: loadCommandHistoryFile(path, limit),
    onChange: (entries) => saveCommandHistoryFile(path, entries),
  });
}
