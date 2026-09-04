import assert from "node:assert/strict";
import { constants } from "node:fs";
import * as realFs from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";

import { createTeamCatalog } from "../../packages/pi-teams/src/core/catalog.ts";
import { TEAM_LIMITS } from "../../packages/pi-teams/src/core/limits.ts";
import { loadTeamCatalog } from "../../packages/pi-teams/src/storage/catalog-loader.ts";

function definition(name) {
  return {
    apiVersion: "pi.dev/teams/v1alpha1",
    kind: "Team",
    metadata: { name, description: `${name} team` },
    spec: {
      limits: {
        maxConcurrency: 1,
        maxCostUsd: 1,
        timeoutMs: 1_000,
        maxMembers: 1,
      },
      members: [{
        id: "reader",
        route: "research",
        capabilities: ["repo.read"],
        tools: ["read"],
        needs: [],
        instructions: "Read repository evidence.",
      }],
    },
  };
}

function entry(source, name, origin = `${source}-${name}.yaml`) {
  return {
    ref: `${source}/${name}`,
    source,
    origin,
    definition: definition(name),
  };
}

function manifest(name) {
  return `apiVersion: pi.dev/teams/v1alpha1
kind: Team
metadata:
  name: ${name}
  description: ${name} team
spec:
  limits:
    maxConcurrency: 1
    maxCostUsd: 1
    timeoutMs: 1000
    maxMembers: 1
  members:
    - id: reader
      route: research
      capabilities: [repo.read]
      tools: [read]
      instructions: Read repository evidence.
`;
}

function padManifest(source, bytes) {
  const remaining = bytes - Buffer.byteLength(source);
  assert.ok(remaining >= 2);
  return `${source}#${"x".repeat(remaining - 2)}\n`;
}

async function fixture(run) {
  const root = await realFs.mkdtemp(join(tmpdir(), "teams-catalog-"));
  const paths = {
    root,
    builtinsDir: join(root, "builtins"),
    userDir: join(root, "user"),
    projectDir: join(root, "project"),
  };
  await Promise.all([
    realFs.mkdir(paths.builtinsDir),
    realFs.mkdir(paths.userDir),
    realFs.mkdir(paths.projectDir),
  ]);
  try {
    return await run(paths);
  } finally {
    await realFs.rm(root, { recursive: true, force: true });
  }
}

function defaultLoad(paths, overrides = {}) {
  return loadTeamCatalog({
    builtinsDir: paths.builtinsDir,
    userDir: paths.userDir,
    projectDir: paths.projectDir,
    projectTrusted: true,
    ...overrides,
  });
}

function isWithin(root, candidate) {
  const normalizedRoot = `${resolve(root)}${sep}`;
  return resolve(candidate) === resolve(root) || resolve(candidate).startsWith(normalizedRoot);
}

function isDescriptorPath(path) {
  return path.startsWith("/proc/self/fd/") || path.startsWith("/dev/fd/");
}

test("catalog sorts qualified refs and resolves exact and unique short names", () => {
  const catalog = createTeamCatalog([
    entry("user", "solo"),
    entry("project", "investigate"),
    entry("builtin", "investigate"),
  ]);

  assert.deepEqual(catalog.list().map(({ ref }) => ref), [
    "builtin/investigate",
    "project/investigate",
    "user/solo",
  ]);
  assert.equal(catalog.resolve("builtin/investigate").ref, "builtin/investigate");
  assert.equal(catalog.resolve("solo").ref, "user/solo");
});

test("catalog reports every ambiguous candidate without namespace precedence", () => {
  const catalog = createTeamCatalog([
    entry("project", "investigate"),
    entry("user", "investigate"),
    entry("builtin", "investigate"),
  ]);

  assert.throws(
    () => catalog.resolve("investigate"),
    /catalog_ambiguous.*builtin\/investigate.*project\/investigate.*user\/investigate/,
  );
});

test("catalog rejects duplicate qualified refs and missing refs with stable errors", () => {
  assert.throws(
    () => createTeamCatalog([
      entry("user", "solo", "first.yaml"),
      entry("user", "solo", "second.yaml"),
    ]),
    /catalog_duplicate.*user\/solo/,
  );
  assert.throws(
    () => createTeamCatalog([]).resolve("missing"),
    /catalog_not_found.*missing/,
  );
});

test("catalog freezes copied entries and does not expose its list storage", () => {
  const original = entry("user", "solo");
  const catalog = createTeamCatalog([original]);
  original.ref = "user/changed";

  const first = catalog.list();
  assert.equal(first[0].ref, "user/solo");
  assert.ok(Object.isFrozen(first[0]));
  assert.throws(() => { first[0].origin = "changed.yaml"; }, TypeError);
  first.length = 0;
  assert.equal(catalog.list().length, 1);
});

test("untrusted loading performs no filesystem operation beneath the project path", async () => {
  await fixture(async (paths) => {
    await realFs.writeFile(join(paths.builtinsDir, "investigate.yaml"), manifest("investigate"));
    await realFs.writeFile(join(paths.projectDir, "private.yaml"), manifest("private"));
    const projectCalls = [];
    const spy = (name, operation) => async (path, ...args) => {
      if (isWithin(paths.projectDir, path)) projectCalls.push(`${name}:${path}`);
      return operation(path, ...args);
    };
    const spyingFs = {
      lstat: spy("lstat", realFs.lstat),
      realpath: spy("realpath", realFs.realpath),
      readdir: spy("readdir", realFs.readdir),
      open: spy("open", realFs.open),
    };

    const catalog = await defaultLoad(paths, {
      projectTrusted: false,
      fs: spyingFs,
    });

    assert.deepEqual(projectCalls, []);
    assert.deepEqual(catalog.list().map(({ ref }) => ref), ["builtin/investigate"]);
  });
});

test("trusted loading includes project manifests under the project namespace", async () => {
  await fixture(async (paths) => {
    await realFs.writeFile(join(paths.projectDir, "team.yaml"), manifest("project-team"));

    const catalog = await defaultLoad(paths);

    assert.equal(catalog.resolve("project/project-team").source, "project");
    assert.equal(catalog.resolve("project/project-team").origin, join(paths.projectDir, "team.yaml"));
  });
});

test("loader processes YAML filenames in lexical order", async () => {
  await fixture(async (paths) => {
    await Promise.all([
      realFs.writeFile(join(paths.builtinsDir, "z.yaml"), manifest("zed")),
      realFs.writeFile(join(paths.builtinsDir, "a.yaml"), manifest("alpha")),
      realFs.writeFile(join(paths.builtinsDir, "ä.yaml"), manifest("omega")),
    ]);
    const opened = [];
    const spyingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: async (path, options) => {
        const entries = await realFs.readdir(path, options);
        return path === paths.builtinsDir ? entries.reverse() : entries;
      },
      open: async (path, flags) => {
        if (path.endsWith(".yaml")) opened.push(basename(path));
        return realFs.open(path, flags);
      },
    };

    await defaultLoad(paths, { fs: spyingFs });

    assert.deepEqual(opened, ["a.yaml", "z.yaml", "ä.yaml"]);
  });
});

test("loader rejects a 33rd YAML file before opening manifests", async () => {
  await fixture(async (paths) => {
    await Promise.all(Array.from({ length: TEAM_LIMITS.catalogFiles + 1 }, (_, index) =>
      realFs.writeFile(join(paths.builtinsDir, `${String(index).padStart(2, "0")}.yaml`), "invalid")));
    let opens = 0;
    const spyingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: realFs.readdir,
      open: async (...args) => {
        if (args[0].endsWith(".yaml")) opens += 1;
        return realFs.open(...args);
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: spyingFs }), /catalog_files/);
    assert.equal(opens, 0);
  });
});

test("loader rejects aggregate bytes above 1,048,576", async () => {
  await fixture(async (paths) => {
    await Promise.all(Array.from({ length: 17 }, (_, index) => {
      const name = `team-${index}`;
      return realFs.writeFile(
        join(paths.builtinsDir, `${String(index).padStart(2, "0")}.yaml`),
        padManifest(manifest(name), 61_681),
      );
    }));

    await assert.rejects(defaultLoad(paths), /catalog_bytes/);
  });
});

test("file-count ceilings reset for each namespace", async () => {
  await fixture(async (paths) => {
    await Promise.all(["builtinsDir", "userDir"].flatMap((directoryKey) =>
      Array.from({ length: 17 }, (_, index) => realFs.writeFile(
        join(paths[directoryKey], `${String(index).padStart(2, "0")}.yaml`),
        manifest(`${directoryKey === "builtinsDir" ? "builtin" : "user"}-${index}`),
      ))));

    const catalog = await defaultLoad(paths);

    assert.equal(catalog.list().length, 34);
    assert.equal(catalog.resolve("builtin/builtin-16").source, "builtin");
    assert.equal(catalog.resolve("user/user-16").source, "user");
  });
});

test("aggregate-byte ceilings reset for each namespace", async () => {
  await fixture(async (paths) => {
    await Promise.all(["builtinsDir", "userDir"].flatMap((directoryKey) =>
      Array.from({ length: 9 }, (_, index) => {
        const prefix = directoryKey === "builtinsDir" ? "builtin" : "user";
        return realFs.writeFile(
          join(paths[directoryKey], `${String(index).padStart(2, "0")}.yaml`),
          padManifest(manifest(`${prefix}-${index}`), 60_000),
        );
      })));

    const catalog = await defaultLoad(paths);

    assert.equal(catalog.list().length, 18);
    assert.equal(catalog.resolve("builtin/builtin-8").source, "builtin");
    assert.equal(catalog.resolve("user/user-8").source, "user");
  });
});

test("loader rejects a manifest above the per-file byte limit", async () => {
  await fixture(async (paths) => {
    await realFs.writeFile(
      join(paths.builtinsDir, "large.yaml"),
      padManifest(manifest("large"), TEAM_LIMITS.manifestBytes + 1),
    );

    await assert.rejects(defaultLoad(paths), /catalog_file_bytes/);
  });
});

test("loader rejects symlinked roots and manifest files", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is privilege-dependent on Windows");
    return;
  }

  await fixture(async (paths) => {
    const actual = join(paths.root, "actual-builtins");
    await realFs.mkdir(actual);
    const linkedRoot = join(paths.root, "linked-builtins");
    await realFs.symlink(actual, linkedRoot, "dir");
    await assert.rejects(
      defaultLoad(paths, { builtinsDir: linkedRoot }),
      /catalog_root_symlink/,
    );

    const target = join(paths.root, "target.yaml");
    await realFs.writeFile(target, manifest("linked"));
    await realFs.symlink(target, join(paths.builtinsDir, "linked.yaml"));
    await assert.rejects(defaultLoad(paths), /catalog_symlink/);
  });
});

test("loader rejects escaped realpaths", async () => {
  await fixture(async (paths) => {
    const candidate = join(paths.builtinsDir, "team.yaml");
    const escaped = join(paths.root, "escaped.yaml");
    await Promise.all([
      realFs.writeFile(candidate, manifest("team")),
      realFs.writeFile(escaped, manifest("escaped")),
    ]);
    const escapingFs = {
      lstat: realFs.lstat,
      realpath: async (path) =>
        isDescriptorPath(path) && basename(path) === "team.yaml"
          ? escaped
          : realFs.realpath(path),
      readdir: realFs.readdir,
      open: realFs.open,
    };

    await assert.rejects(defaultLoad(paths, { fs: escapingFs }), /catalog_escape/);
  });
});

test("loader stays bound to the admitted root descriptor during parent replacement", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the real descriptor-root race fixture requires Linux procfs");
    return;
  }

  await fixture(async (paths) => {
    await realFs.writeFile(join(paths.builtinsDir, "safe.yaml"), manifest("safe"));
    const movedRoot = join(paths.root, "admitted-builtins");
    let replaced = false;
    const racingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      open: realFs.open,
      readdir: async (path, options) => {
        if (!replaced && (path === paths.builtinsDir || isDescriptorPath(path))) {
          replaced = true;
          await realFs.rename(paths.builtinsDir, movedRoot);
          await realFs.mkdir(paths.builtinsDir);
          await realFs.writeFile(join(paths.builtinsDir, "evil.yaml"), manifest("evil"));
        }
        return realFs.readdir(path, options);
      },
    };

    const catalog = await defaultLoad(paths, { fs: racingFs });

    assert.equal(replaced, true);
    assert.deepEqual(catalog.list().map(({ ref }) => ref), ["builtin/safe"]);
  });
});

test("loader fails closed when no verified descriptor-root path is available", async () => {
  await fixture(async (paths) => {
    await realFs.writeFile(join(paths.builtinsDir, "team.yaml"), manifest("team"));
    let manifestOpens = 0;
    const unavailableFs = {
      lstat: realFs.lstat,
      readdir: realFs.readdir,
      open: async (path, flags) => {
        if (path.endsWith(".yaml")) manifestOpens += 1;
        return realFs.open(path, flags);
      },
      realpath: async (path) => {
        if (isDescriptorPath(path)) {
          const error = new Error("descriptor path unavailable");
          error.code = "ENOENT";
          throw error;
        }
        return realFs.realpath(path);
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: unavailableFs }), /catalog_descriptor_path/);
    assert.equal(manifestOpens, 0);
  });
});

test("loader rejects non-regular .yaml entries", async () => {
  await fixture(async (paths) => {
    await realFs.mkdir(join(paths.builtinsDir, "directory.yaml"));

    await assert.rejects(defaultLoad(paths), /catalog_regular/);
  });
});

test("loader rejects an identity change between lstat and fstat and closes the file", async () => {
  await fixture(async (paths) => {
    const candidate = join(paths.builtinsDir, "team.yaml");
    await realFs.writeFile(candidate, manifest("team"));
    let closed = false;
    const identityChangingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: realFs.readdir,
      open: async (path, flags) => {
        const handle = await realFs.open(path, flags);
        if ((flags & constants.O_DIRECTORY) !== 0) return handle;
        return {
          fd: handle.fd,
          stat: async () => {
            const stat = await handle.stat();
            return {
              dev: stat.dev,
              ino: stat.ino + 1,
              size: stat.size,
              isFile: () => stat.isFile(),
            };
          },
          read: (...args) => handle.read(...args),
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: identityChangingFs }), /catalog_identity/);
    assert.equal(closed, true);
  });
});

test("loader opens no-follow read-only, rejects malformed UTF-8, and closes the file", async () => {
  await fixture(async (paths) => {
    const candidate = join(paths.builtinsDir, "team.yaml");
    await realFs.writeFile(candidate, Buffer.from([0xff]));
    let observedFlags;
    let closed = false;
    const spyingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: realFs.readdir,
      open: async (path, flags) => {
        const handle = await realFs.open(path, flags);
        if ((flags & constants.O_DIRECTORY) !== 0) return handle;
        observedFlags = flags;
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          read: (...args) => handle.read(...args),
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: spyingFs }), /catalog_utf8/);
    assert.equal(observedFlags & constants.O_ACCMODE, constants.O_RDONLY);
    if (constants.O_NOFOLLOW !== undefined) {
      assert.equal(observedFlags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    }
    assert.equal(closed, true);
  });
});

test("loader bounds descriptor reads when a manifest grows after fstat", async () => {
  await fixture(async (paths) => {
    const candidate = join(paths.builtinsDir, "growing.yaml");
    await realFs.writeFile(candidate, manifest("growing"));
    let readCapacity = 0;
    let grew = false;
    const growingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: realFs.readdir,
      open: async (path, flags) => {
        const handle = await realFs.open(path, flags);
        if ((flags & constants.O_DIRECTORY) !== 0) return handle;
        return {
          fd: handle.fd,
          stat: async () => {
            const stat = await handle.stat();
            if (!grew) {
              grew = true;
              await realFs.appendFile(candidate, "x".repeat(TEAM_LIMITS.manifestBytes + 1));
            }
            return stat;
          },
          read: async (buffer, offset, length, position) => {
            readCapacity = Math.max(readCapacity, buffer.byteLength);
            return handle.read(buffer, offset, length, position);
          },
          readFile: async () => {
            throw new Error("unbounded readFile must not be used");
          },
          close: () => handle.close(),
        };
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: growingFs }), /catalog_file_bytes/);
    assert.equal(grew, true);
    assert.equal(readCapacity, TEAM_LIMITS.manifestBytes + 1);
  });
});

test("loader caps growth reads at the remaining per-source aggregate plus one", async () => {
  await fixture(async (paths) => {
    await Promise.all(Array.from({ length: 16 }, (_, index) => realFs.writeFile(
      join(paths.builtinsDir, `${String(index).padStart(2, "0")}.yaml`),
      padManifest(manifest(`team-${index}`), 62_000),
    )));
    const candidate = join(paths.builtinsDir, "zz.yaml");
    await realFs.writeFile(candidate, manifest("growing"));
    let readCapacity = 0;
    let grew = false;
    const growingFs = {
      lstat: realFs.lstat,
      realpath: realFs.realpath,
      readdir: realFs.readdir,
      open: async (path, flags) => {
        const handle = await realFs.open(path, flags);
        if ((flags & constants.O_DIRECTORY) !== 0 || basename(path) !== "zz.yaml") {
          return handle;
        }
        return {
          fd: handle.fd,
          stat: async () => {
            const stat = await handle.stat();
            if (!grew) {
              grew = true;
              await realFs.appendFile(candidate, "x".repeat(60_000));
            }
            return stat;
          },
          read: async (buffer, offset, length, position) => {
            readCapacity = Math.max(readCapacity, buffer.byteLength);
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    };

    await assert.rejects(defaultLoad(paths, { fs: growingFs }), /catalog_bytes/);
    assert.equal(grew, true);
    assert.equal(
      readCapacity,
      TEAM_LIMITS.catalogBytes - (16 * 62_000) + 1,
    );
  });
});

test("loader surfaces duplicate qualified names from separate files", async () => {
  await fixture(async (paths) => {
    await Promise.all([
      realFs.writeFile(join(paths.userDir, "a.yaml"), manifest("duplicate")),
      realFs.writeFile(join(paths.userDir, "b.yaml"), manifest("duplicate")),
    ]);

    await assert.rejects(defaultLoad(paths), /catalog_duplicate.*user\/duplicate/);
  });
});

test("loader ignores non-.yaml entries", async () => {
  await fixture(async (paths) => {
    await Promise.all([
      realFs.writeFile(join(paths.builtinsDir, "ignored.yml"), "invalid"),
      realFs.writeFile(join(paths.builtinsDir, "ignored.txt"), "invalid"),
      realFs.writeFile(join(paths.builtinsDir, "loaded.yaml"), manifest("loaded")),
    ]);

    const catalog = await defaultLoad(paths);

    assert.deepEqual(catalog.list().map(({ ref }) => ref), ["builtin/loaded"]);
  });
});
