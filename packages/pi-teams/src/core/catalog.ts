import type { CatalogEntry, TeamCatalog } from "./types.ts";

function catalogError(code: string, message: string): Error {
  return new Error(`${code}:${message}`);
}

export function createTeamCatalog(entries: CatalogEntry[]): TeamCatalog {
  const sorted = entries
    .map((entry) => Object.freeze({ ...entry }))
    .sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  const qualified = new Map<string, CatalogEntry>();
  const short = new Map<string, CatalogEntry[]>();

  for (const entry of sorted) {
    if (qualified.has(entry.ref)) {
      throw catalogError("catalog_duplicate", `duplicate qualified ref ${entry.ref}`);
    }
    qualified.set(entry.ref, entry);

    const name = entry.definition.metadata.name;
    const matches = short.get(name) ?? [];
    matches.push(entry);
    short.set(name, matches);
  }

  return Object.freeze({
    list(): CatalogEntry[] {
      return [...sorted];
    },
    resolve(ref: string): CatalogEntry {
      const exact = qualified.get(ref);
      if (exact !== undefined) return exact;

      const matches = short.get(ref) ?? [];
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw catalogError(
          "catalog_ambiguous",
          `${ref} matches ${matches.map((entry) => entry.ref).join(", ")}`,
        );
      }
      throw catalogError("catalog_not_found", ref);
    },
  });
}
