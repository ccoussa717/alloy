import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SHA = "a" * 40
VERSION = "1.1.25"


class ReleaseWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy wrapper ")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo with spaces"
        self.candidate = self.root / "candidate object"
        self.bin = self.root / "fixture bin"
        self.repo.mkdir()
        self.candidate.mkdir()
        self.bin.mkdir()
        for root in (self.repo, self.candidate):
            (root / "benchmarks" / "swebench").mkdir(parents=True)
            (root / "package.json").write_text(
                json.dumps(
                    {
                        "version": VERSION,
                        "alloy": {"piFork": {"version": "0.82.1"}},
                    }
                )
                + "\n"
            )
        (self.repo / "benchmarks" / "swebench" / ".venv" / "bin").mkdir(
            parents=True
        )
        (self.repo / "benchmarks" / "swebench" / "profile.json").write_text(
            "LIVE_PROFILE\n"
        )
        (self.repo / "benchmarks" / "swebench" / "requirements.txt").write_text(
            "swebench==5.0.0\n"
        )
        (self.repo / "benchmarks" / "swebench" / "runner.py").write_text(
            "LIVE_RUNNER\n"
        )
        (self.repo / "install.sh").write_text("#!/bin/sh\n")
        (self.candidate / "install.sh").write_text("SNAPSHOT_INSTALLER\n")
        (self.candidate / "benchmarks" / "swebench" / "profile.json").write_text(
            "SNAPSHOT_PROFILE\n"
        )
        (self.candidate / "benchmarks" / "swebench" / "runner.py").write_text(
            "SNAPSHOT_RUNNER\n"
        )
        self.archive = self.root / "candidate.tar"
        subprocess.run(
            [
                "/bin/tar",
                "-cf",
                str(self.archive),
                "-C",
                str(self.candidate),
                "package.json",
                "install.sh",
                "benchmarks/swebench",
            ],
            check=True,
        )
        self.installer_log = self.root / "installer.jsonl"
        self.runner_log = self.root / "runner.jsonl"
        self.command_log = self.root / "commands.jsonl"
        self.git_log = self.root / "git.jsonl"
        self.results_root = self.repo / "benchmarks" / "swebench" / "results"
        self.result_dir = self.results_root / "run-1"
        self.host_zdotdir = self.root / "host zdotdir"
        self.host_zdotdir.mkdir()
        self.host_zshrc = self.host_zdotdir / ".zshrc"
        self.host_zshrc.write_text("host sentinel\n")
        self._write_git_fixture()
        self._write_python_fixture()
        self._write_installer_fixture()
        self._write_runner_fixture()
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "ZDOTDIR": str(self.host_zdotdir),
            "FAKE_REPO": str(self.repo),
            "FAKE_SHA": SHA,
            "FAKE_REMOTE_SHA": SHA,
            "FAKE_REMOTE_URL": "https://github.com/ccoussa717/alloy.git",
            "FAKE_ARCHIVE_FILE": str(self.archive),
            "FAKE_INSTALLER_LOG": str(self.installer_log),
            "FAKE_RUNNER_LOG": str(self.runner_log),
            "FAKE_COMMAND_LOG": str(self.command_log),
            "FAKE_GIT_LOG": str(self.git_log),
            "FAKE_RESULT_DIR": str(self.result_dir),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def _executable(self, path: Path, source: str) -> None:
        path.write_text(source)
        path.chmod(0o755)

    def _write_git_fixture(self) -> None:
        self._executable(
            self.bin / "git",
            """#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"
case "$1 $2" in
  "rev-parse --show-toplevel") printf '%s\n' "$FAKE_REPO" ;;
  "rev-parse HEAD") printf '%s\n' "$FAKE_SHA" ;;
  "status --porcelain=v1")
    [ "$3" = "--untracked-files=no" ] || exit 91
    [ "${FAKE_STATUS_FAILURE:-0}" -eq 0 ] || exit "$FAKE_STATUS_FAILURE"
    printf '%s' "${FAKE_STATUS:-}"
    ;;
  "remote get-url")
    [ "$3" = "${FAKE_EXPECTED_REMOTE:-github}" ] || exit 92
    printf '%s\n' "$FAKE_REMOTE_URL"
    ;;
  "ls-remote "*)
    [ "$2" = "${FAKE_EXPECTED_REMOTE:-github}" ] || exit 92
    [ "${FAKE_LS_REMOTE_STATUS:-0}" -eq 0 ] || exit "$FAKE_LS_REMOTE_STATUS"
    if [ -n "${FAKE_REMOTE_REFS+x}" ]; then
      printf '%s' "$FAKE_REMOTE_REFS"
    else
      printf '%s\trefs/heads/feature\n' "$FAKE_REMOTE_SHA"
    fi
    ;;
  "archive --format=tar")
    [ "${FAKE_ARCHIVE_STATUS:-0}" -eq 0 ] || exit "$FAKE_ARCHIVE_STATUS"
    output=''
    for argument in "$@"; do
      case "$argument" in --output=*) output=${argument#--output=} ;; esac
    done
    [ -n "$output" ] || exit 93
    cp "$FAKE_ARCHIVE_FILE" "$output"
    if [ "${FAKE_MUTATE_LIVE:-0}" -eq 1 ]; then
      printf '%s\n' 'MUTATED_LIVE_RUNNER' > "$FAKE_REPO/benchmarks/swebench/runner.py"
      printf '%s\n' 'MUTATED_LIVE_PROFILE' > "$FAKE_REPO/benchmarks/swebench/profile.json"
      printf '%s\n' '{"version":"9.9.9"}' > "$FAKE_REPO/package.json"
    fi
    if [ "${FAKE_MUTATE_LIVE_INSTALLER:-0}" -eq 1 ]; then
      printf '%s\n' 'MUTATED_LIVE_INSTALLER' > "$FAKE_REPO/install.sh"
    fi
    ;;
  *) printf 'unexpected git command: %s\n' "$*" >&2; exit 91 ;;
esac
""",
        )

    def _write_python_fixture(self) -> None:
        self._executable(
            self.bin / "python3",
            """#!/bin/sh
if [ "$1 $2" = "-m unittest" ]; then
  printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
  exit "${FAKE_PYTHON_STATUS:-0}"
fi
if [ "$1 $2" != "-m venv" ]; then
  exec /usr/bin/python3 "$@"
fi
printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
mkdir -p "$3/bin"
cat > "$3/bin/python" <<'PYTHON'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_COMMAND_LOG"
PYTHON
chmod +x "$3/bin/python"
exit "${FAKE_PYTHON_STATUS:-0}"
""",
        )

    def _write_installer_fixture(self) -> None:
        self._executable(
            self.bin / "bash",
            """#!/bin/sh
/usr/bin/python3 - "$FAKE_INSTALLER_LOG" "$@" <<'PY'
import json
import os
import sys

keys = [
    "ALLOY_REF", "ALLOY_CHANNEL", "HOME", "ZDOTDIR", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "TMPDIR", "ALLOY_PREFIX", "BASH_ENV", "ENV",
]
record = {
    "argv": sys.argv[2:],
    "env": {key: os.environ.get(key) for key in keys},
    "installer_source": open(sys.argv[2], encoding="utf-8").read(),
}
with open(sys.argv[1], "a", encoding="utf-8") as log:
    log.write(json.dumps(record, sort_keys=True) + "\\n")
PY
[ "${FAKE_INSTALLER_STATUS:-0}" -eq 0 ] || exit "$FAKE_INSTALLER_STATUS"
printf '%s\n' 'fixture touched' >> "$ZDOTDIR/.zshrc"
mkdir -p "$ALLOY_PREFIX/bin" "$XDG_DATA_HOME/alloy/app"
cat > "$ALLOY_PREFIX/bin/alloy" <<'ALLOY'
#!/bin/sh
printf 'Alloy %s\nPi    0.82.1\nNode  v22.22.3\n' "${FAKE_ALLOY_VERSION:-1.1.25}"
ALLOY
chmod +x "$ALLOY_PREFIX/bin/alloy"
printf '{"version":"%s","alloy":{"piFork":{"version":"0.82.1"}}}\n' "${FAKE_APP_VERSION:-1.1.25}" > "$XDG_DATA_HOME/alloy/app/package.json"
printf '{"commit":"%s","version":"%s"}\n' "${FAKE_MANIFEST_COMMIT:-$ALLOY_REF}" "${FAKE_MANIFEST_VERSION:-1.1.25}" > "$XDG_DATA_HOME/alloy/install-manifest.json"
""",
        )

    def _write_runner_fixture(self) -> None:
        self._executable(
            self.repo / "benchmarks" / "swebench" / ".venv" / "bin" / "python",
            """#!/usr/bin/python3
import json
import os
import sys
from pathlib import Path

arguments = sys.argv[1:]
def option(name):
    return arguments[arguments.index(name) + 1]

runner_path = Path(arguments[0])
profile_path = Path(option("--profile"))
record = {
    "argv": arguments,
    "runner_source": runner_path.read_text(),
    "profile_source": profile_path.read_text(),
}
with open(os.environ["FAKE_RUNNER_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(record, sort_keys=True) + "\\n")

results_root = Path(option("--results-root"))
run_dir = Path(os.environ.get("FAKE_RESULT_DIR", str(results_root / "run-1")))
pointer_path = Path(option("--run-path-file"))
token = option("--run-token")
mode = os.environ.get("FAKE_POINTER_MODE", "valid")
candidate_commit = option("--candidate-commit")
candidate_root = option("--candidate-root")

if mode == "stale":
    run_dir = Path(os.environ["FAKE_STALE_DIR"])
elif mode == "escape":
    run_dir = Path(os.environ["FAKE_ESCAPE_DIR"])
elif mode == "symlink_escape":
    outside = Path(os.environ["FAKE_ESCAPE_DIR"])
    outside.mkdir(parents=True, exist_ok=True)
    run_dir = results_root / "linked-run"
    run_dir.parent.mkdir(parents=True, exist_ok=True)
    run_dir.symlink_to(outside, target_is_directory=True)

if mode not in {"missing", "malformed", "stale"}:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "summary.json").write_text('{"status":"fixture-result"}\\n')
    (run_dir / "manifest.json").write_text(
        json.dumps(
            {
                "candidate_commit": candidate_commit,
                "candidate_source_root": candidate_root,
                "run_id": run_dir.name,
            }
        )
        + "\\n"
    )

if mode == "malformed":
    pointer_path.write_text("{not-json\\n")
elif mode != "missing":
    pointer = {
        "schema_version": 1,
        "candidate_commit": candidate_commit,
        "results_root": str(results_root),
        "run_dir": str(run_dir),
        "run_id": run_dir.name,
        "run_token": token,
    }
    if mode == "mismatch":
        pointer["candidate_commit"] = "b" * 40
    pointer_path.write_text(json.dumps(pointer) + "\\n")

raise SystemExit(int(os.environ.get("FAKE_RUNNER_STATUS", "0")))
""",
        )

    def _run(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                "/bin/bash",
                str(
                    Path(__file__).resolve().parents[3]
                    / "scripts"
                    / "run-swebench-release-smoke.sh"
                ),
                *arguments,
            ],
            cwd=self.repo,
            env={**self.environment, **environment},
            text=True,
            capture_output=True,
            check=False,
        )

    def _records(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines()]

    def _installer_record(self) -> dict:
        records = self._records(self.installer_log)
        self.assertEqual(len(records), 1)
        return records[0]

    def _runner_record(self) -> dict:
        records = self._records(self.runner_log)
        self.assertEqual(len(records), 1)
        return records[0]

    def test_release_subcommand_fails_closed_pending_trusted_isolation(self):
        result = self._run("release", FAKE_STATUS_FAILURE="23")
        self.assertEqual(result.returncode, 1)
        self.assertIn("disabled pending trusted isolation", result.stderr)
        self.assertFalse(self.git_log.exists())
        self.assertFalse(self.installer_log.exists())
        self.assertFalse(self.runner_log.exists())

    def test_wrapper_fails_closed_when_git_status_fails(self):
        result = self._run("dry-run", FAKE_STATUS_FAILURE="23")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not verify clean tracked worktree", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_dirty_tracked_worktree(self):
        result = self._run("dry-run", FAKE_STATUS=" M package.json\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clean tracked worktree", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_peeled_tag_as_remote_tip(self):
        result = self._run("dry-run", FAKE_REMOTE_REFS=f"{SHA}\trefs/tags/v1.1.25^{{}}\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("advertised ref tip", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_commit_not_advertised_by_remote(self):
        result = self._run("dry-run", FAKE_REMOTE_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("advertised ref tip", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_isolates_production_installer_environment_and_zdotdir(self):
        real_installer = Path(__file__).resolve().parents[3] / "install.sh"
        self.assertIn('${ZDOTDIR:-$HOME}/.zshrc', real_installer.read_text())
        result = self._run("dry-run", BASH_ENV="/host/bash-env", ENV="/host/env")
        self.assertEqual(result.returncode, 0, result.stderr)
        install = self._installer_record()
        environment = install["env"]
        temporary_root = Path(environment["HOME"]).parent
        self.assertEqual(environment["ALLOY_REF"], SHA)
        self.assertEqual(environment["ALLOY_CHANNEL"], "main")
        self.assertEqual(environment["BASH_ENV"], None)
        self.assertEqual(environment["ENV"], None)
        for key, leaf in (
            ("HOME", "home"),
            ("ZDOTDIR", "zdotdir"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_RUNTIME_DIR", "runtime"),
            ("TMPDIR", "tmp"),
            ("ALLOY_PREFIX", "prefix"),
        ):
            self.assertEqual(Path(environment[key]), temporary_root / leaf)
        self.assertEqual(self.host_zshrc.read_text(), "host sentinel\n")
        self.assertFalse(temporary_root.exists())

    def test_wrapper_uses_immutable_snapshot_and_installed_candidate_root(self):
        result = self._run("dry-run", FAKE_MUTATE_LIVE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self._runner_record()
        arguments = run["argv"]
        self.assertEqual(run["runner_source"], "SNAPSHOT_RUNNER\n")
        self.assertEqual(run["profile_source"], "SNAPSHOT_PROFILE\n")
        self.assertIn("snapshot", arguments[0])
        self.assertIn("snapshot", arguments[arguments.index("--profile") + 1])
        candidate_root = Path(arguments[arguments.index("--candidate-root") + 1])
        self.assertEqual(candidate_root.name, "app")
        self.assertEqual(candidate_root.parent.name, "alloy")
        self.assertNotEqual(candidate_root, self.repo)

    def test_wrapper_executes_snapshot_installer_after_live_installer_mutation(self):
        result = self._run("dry-run", FAKE_MUTATE_LIVE_INSTALLER="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        install = self._installer_record()
        temporary_root = Path(install["env"]["HOME"]).parent
        self.assertEqual(
            install["argv"],
            [str(temporary_root / "snapshot" / "install.sh")],
        )
        self.assertEqual(install["installer_source"], "SNAPSHOT_INSTALLER\n")
        self.assertEqual(
            (self.repo / "install.sh").read_text(),
            "MUTATED_LIVE_INSTALLER\n",
        )

    def test_wrapper_passes_exact_json_logged_arguments_once_with_whitespace_paths(self):
        result = self._run(
            "dry-run",
            ALLOY_BENCH_REMOTE="release-origin",
            FAKE_EXPECTED_REMOTE="release-origin",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        install = self._installer_record()
        temporary_root = Path(install["env"]["HOME"]).parent
        self.assertEqual(
            install["argv"],
            [str(temporary_root / "snapshot" / "install.sh")],
        )
        arguments = self._runner_record()["argv"]
        self.assertEqual(
            arguments,
            [
                str(
                    temporary_root
                    / "snapshot"
                    / "benchmarks"
                    / "swebench"
                    / "runner.py"
                ),
                "--profile",
                str(
                    temporary_root
                    / "snapshot"
                    / "benchmarks"
                    / "swebench"
                    / "profile.json"
                ),
                "--alloy-bin",
                str(Path(install["env"]["ALLOY_PREFIX"]) / "bin" / "alloy"),
                "--candidate-root",
                str(temporary_root / "data" / "alloy" / "app"),
                "--candidate-commit",
                SHA,
                "--install-manifest",
                str(temporary_root / "data" / "alloy" / "install-manifest.json"),
                "--results-root",
                str(self.results_root),
                "--run-path-file",
                str(temporary_root / "run-path.json"),
                "--run-token",
                temporary_root.name,
                "--venv-python",
                str(
                    self.repo
                    / "benchmarks"
                    / "swebench"
                    / ".venv"
                    / "bin"
                    / "python"
                ),
                "--dry-run",
            ],
        )

    def test_wrapper_preserves_runner_exit_and_persisted_pointed_result(self):
        result = self._run("dry-run", FAKE_RUNNER_STATUS="5")
        self.assertEqual(result.returncode, 5)
        self.assertIn(f"benchmark result: {self.result_dir}", result.stdout)
        self.assertEqual(
            (self.result_dir / "summary.json").read_text(),
            '{"status":"fixture-result"}\n',
        )
        self.assertIn("--dry-run", self._runner_record()["argv"])

    def test_wrapper_rejects_missing_or_malformed_pointer(self):
        for mode in ("missing", "malformed"):
            with self.subTest(mode=mode):
                if self.runner_log.exists():
                    self.runner_log.unlink()
                result = self._run("dry-run", FAKE_POINTER_MODE=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("run path pointer", result.stderr)
                self.assertEqual(len(self._records(self.runner_log)), 1)

    def test_wrapper_preserves_nonzero_runner_exit_when_pointer_is_invalid(self):
        result = self._run("dry-run", FAKE_POINTER_MODE="missing", FAKE_RUNNER_STATUS="7")
        self.assertEqual(result.returncode, 7)
        self.assertIn("run path pointer", result.stderr)
        self.assertEqual(len(self._records(self.runner_log)), 1)

    def test_wrapper_rejects_mismatched_pointer(self):
        result = self._run("dry-run", FAKE_POINTER_MODE="mismatch")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run path pointer", result.stderr)

    def test_wrapper_rejects_stale_pointer_target(self):
        stale = self.results_root / "old-run"
        stale.mkdir(parents=True)
        (stale / "summary.json").write_text("old\n")
        result = self._run("dry-run", FAKE_POINTER_MODE="stale", FAKE_STALE_DIR=str(stale))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stale run path", result.stderr)
        self.assertEqual((stale / "summary.json").read_text(), "old\n")

    def test_wrapper_rejects_pointer_outside_or_symlink_escaping_results(self):
        for mode in ("escape", "symlink_escape"):
            with self.subTest(mode=mode):
                if self.runner_log.exists():
                    self.runner_log.unlink()
                escape = self.root / f"outside {mode}"
                result = self._run(
                    "dry-run",
                    FAKE_POINTER_MODE=mode,
                    FAKE_ESCAPE_DIR=str(escape),
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("canonical benchmark results root", result.stderr)

    def test_wrapper_rejects_symlinked_results_root_before_runner(self):
        outside = self.root / "outside results"
        outside.mkdir()
        self.results_root.symlink_to(outside, target_is_directory=True)
        result = self._run("dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("results root", result.stderr)
        self.assertFalse(self.runner_log.exists())

    def test_wrapper_rejects_newline_repository_path(self):
        for repository_path in (f"{self.repo}\nsecond-path", f"{self.repo}\n"):
            with self.subTest(repository_path=repository_path):
                result = self._run("dry-run", FAKE_REPO=repository_path)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("repository path contains a newline", result.stderr)
                self.assertFalse(self.installer_log.exists())

    def test_wrapper_fails_closed_on_git_archive_or_extraction_failure(self):
        cases = (
            {"FAKE_ARCHIVE_STATUS": "27"},
            {"FAKE_ARCHIVE_FILE": str(self.repo / "package.json")},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                if self.installer_log.exists():
                    self.installer_log.unlink()
                result = self._run("dry-run", **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.installer_log.exists())

    def test_wrapper_fails_closed_when_remote_ref_query_fails(self):
        result = self._run("dry-run", FAKE_LS_REMOTE_STATUS="29")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not read advertised refs", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_installed_version_or_manifest_drift(self):
        cases = (
            {"FAKE_ALLOY_VERSION": "1.1.24"},
            {"FAKE_APP_VERSION": "1.1.24"},
            {"FAKE_MANIFEST_VERSION": "1.1.24"},
            {"FAKE_MANIFEST_COMMIT": "b" * 40},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                if self.installer_log.exists():
                    self.installer_log.unlink()
                result = self._run("dry-run", **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("installed candidate", result.stderr)
                self.assertFalse(self.runner_log.exists())

    def test_wrapper_calls_failed_installer_once_without_retry(self):
        result = self._run("dry-run", FAKE_INSTALLER_STATUS="17")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self._records(self.installer_log)), 1)
        self.assertFalse(self.runner_log.exists())

    def test_wrapper_rejects_noncanonical_or_credentialed_remote_url(self):
        result = self._run("dry-run", FAKE_REMOTE_URL="https://token@github.com/ccoussa717/alloy.git")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("canonical GitHub remote", result.stderr)

    def test_wrapper_rejects_non_full_lowercase_candidate_sha(self):
        result = self._run("dry-run", FAKE_SHA="A" * 40, FAKE_REMOTE_SHA="A" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("full lowercase Git SHA", result.stderr)

    def test_wrapper_rejects_unknown_arguments_before_preflight(self):
        result = self._run("unexpected")
        self.assertEqual(result.returncode, 64)
        self.assertIn("usage:", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_test_subcommand_runs_model_free_suite_before_candidate_preflight(self):
        result = self._run("test", FAKE_STATUS_FAILURE="23")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.command_log.read_text().splitlines(),
            [f"-m unittest discover -s {self.repo / 'benchmarks' / 'swebench' / 'tests'} -v"],
        )
        self.assertFalse(self.installer_log.exists())

    def test_setup_subcommand_creates_or_updates_exact_benchmark_venv_before_preflight(self):
        venv = self.repo / "benchmarks" / "swebench" / ".venv"
        existing_python = venv / "bin" / "python"
        existing_python.unlink()
        result = self._run("setup", FAKE_STATUS_FAILURE="23")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.command_log.read_text().splitlines(),
            [
                f"-m venv {venv}",
                f"-m pip install -r {self.repo / 'benchmarks' / 'swebench' / 'requirements.txt'}",
            ],
        )
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_requires_an_explicit_subcommand(self):
        result = self._run()
        self.assertEqual(result.returncode, 64)
        self.assertIn("usage:", result.stderr)
        self.assertFalse(self.installer_log.exists())


if __name__ == "__main__":
    unittest.main()
