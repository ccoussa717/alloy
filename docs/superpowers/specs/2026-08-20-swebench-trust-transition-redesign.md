# SWE-bench Trust Transition Redesign

**Approved:** 2026-08-20
**Scope:** Task 10 remediation on `feat/swebench-trusted-release`

## Decision

No mutable worktree byte may execute with root authority. The release wrapper keeps official modes as fixed `sudo -n` calls and changes `provision` to accept an explicit full authority SHA and print an operator-reviewed bootstrap command. That command uses absolute root-owned tools, the hardcoded canonical HTTPS repository, and a fresh mode-0700 root directory. Only `provision.py` fetched into that root-owned canonical checkout may run under isolated Python.

## Trust Boundaries

### Bootstrap

`run-swebench-release-smoke.sh provision <authority-sha>` validates only the SHA syntax and prints a fixed command. It does not invoke sudo, Python, worktree imports, or local provisioning code. The printed ceremony:

1. Requires the operator-provided full SHA.
2. Creates a fresh root-owned mode-0700 bootstrap directory without replacing an existing path.
3. Uses `/usr/bin/git` with the literal `https://github.com/ccoussa717/alloy.git` URL.
4. Verifies that the requested object is the exact advertised canonical `refs/heads/main` commit.
5. Checks out that commit detached into the root-owned directory.
6. Executes that checkout's `provision.py` with `/usr/bin/python3 -I -E -s` and no path overrides.

Replacement remains a separate explicit old/new authority action performed only from a freshly fetched canonical root-owned checkout.

### Launcher

`host_launcher.py` imports only Python standard-library modules until all trust anchors validate. Its shebang invokes `/usr/bin/python3 -I -E -s`. Before modifying `sys.path` or importing `benchmarks.swebench`, it:

1. Rejects non-root execution.
2. Rejects Python import/configuration environment variables, then installs a fixed minimal environment.
3. Opens every fixed parent and leaf descriptor-relatively with `O_DIRECTORY` or `O_NOFOLLOW`.
4. Verifies ownership, exact modes, regular-file/directory types, and collision-free fixed paths.
5. Parses the fixed config with stdlib JSON and an exact schema.
6. Verifies the authority checkout is clean, detached at the configured SHA, and bound to the canonical remote.
7. Computes the coordinator tree digest from fixed Git tree entries without importing authority code.
8. Computes exact AppArmor, seccomp, public-key, and installed-launcher digests.

Only after those checks pass may the launcher insert the validated authority root into `sys.path` and import coordinator modules. Subprocess tests place import-time tripwires in drifted authority code and prove they never execute.

### Provisioning Filesystem

Provisioning uses descriptor-relative no-follow operations. It opens existing parents one component at a time, rejects symlinks, non-directories, wrong owners, and group/world-writable modes, and never repairs unsafe existing nodes with `chmod`. New directories and files are created relative to validated dirfds with exclusive/no-follow flags, fsynced before publication, and atomically published without replacement. Initial provisioning and explicit replacement have separate collision rules.

### Evaluator

No local or ignored `.venv` is read or copied. After the canonical authority checkout is root-owned, provisioning:

1. Creates the evaluator venv from the fixed root/system Python 3.14.4.
2. Installs the exact authority `requirements.lock` with `--require-hashes --only-binary=:all:` and approved HTTPS package origins only.
3. Verifies Python version, the complete installed distribution set, lock digest, and upstream evaluator source digest.
4. Applies the authority patch using `/usr/bin/patch --batch --forward --fuzz=0`.
5. Verifies the patched evaluator source digest before publishing config or permitting launcher use.

Tests add a malicious local venv and import files and prove neither is opened or executed.

## Failure Handling

Every trust transition fails closed. A malformed environment, unsafe parent, collision, wrong remote object, dirty checkout, digest mismatch, unavailable binary wheel, evaluator drift, patch fuzz, or failed fsync prevents authority publication. Replacement never silently degrades to initial provisioning. Partial state remains non-authoritative unless the canonical config is durably published.

## Tests

Focused subprocess tests exercise the installed launcher and bootstrap boundary, not only helper functions. They cover pre-import authority drift tripwires, Python environment contamination, symlinked roots, unsafe parent modes, mutable local provisioning imports, malicious local evaluator state, exact wrapper argv, and fixed canonical bootstrap output. Existing focused, full Python, shell syntax, compile, and diff checks remain required. No test writes `/etc`, `/usr/local`, or `/var/lib`.
