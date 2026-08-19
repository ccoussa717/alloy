import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SHA = "a" * 40
VERSION = "1.1.25"


class ReleaseWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.bin.mkdir()
        (self.repo / "benchmarks" / "swebench" / ".venv" / "bin").mkdir(
            parents=True
        )
        (self.repo / "benchmarks" / "swebench" / "profile.json").write_text("{}\n")
        (self.repo / "benchmarks" / "swebench" / "runner.py").write_text("\n")
        (self.repo / "package.json").write_text(f'{{"version":"{VERSION}"}}\n')
        (self.repo / "install.sh").write_text("#!/bin/sh\n")
        self.installer_log = self.root / "installer.log"
        self.runner_log = self.root / "runner.log"
        self.result_dir = self.repo / "benchmarks" / "swebench" / "results" / "run-1"
        self._executable(
            self.bin / "git",
            """#!/bin/sh
case "$1 $2" in
  "rev-parse --show-toplevel") printf '%s\n' "$FAKE_REPO" ;;
  "rev-parse HEAD") printf '%s\n' "$FAKE_SHA" ;;
  "status --porcelain=v1")
    [ "$3" = "--untracked-files=no" ] || exit 91
    printf '%s' "${FAKE_STATUS:-}"
    ;;
  "remote get-url")
    [ "$3" = "${FAKE_EXPECTED_REMOTE:-github}" ] || exit 92
    printf '%s\n' "$FAKE_REMOTE_URL"
    ;;
  "ls-remote "*)
    [ "$2" = "${FAKE_EXPECTED_REMOTE:-github}" ] || exit 92
    printf '%s\trefs/heads/feature\n' "$FAKE_REMOTE_SHA"
    ;;
  *) printf 'unexpected git command: %s\n' "$*" >&2; exit 91 ;;
esac
""",
        )
        self._executable(
            self.bin / "bash",
            """#!/bin/sh
printf 'CALL\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' "$ALLOY_REF" "$ALLOY_CHANNEL" "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$ALLOY_PREFIX" >> "$FAKE_INSTALLER_LOG"
for argument in "$@"; do printf '%s\n' "$argument" >> "$FAKE_INSTALLER_LOG"; done
[ "${FAKE_INSTALLER_STATUS:-0}" -eq 0 ] || exit "$FAKE_INSTALLER_STATUS"
mkdir -p "$ALLOY_PREFIX/bin" "$XDG_DATA_HOME/alloy"
cat > "$ALLOY_PREFIX/bin/alloy" <<'ALLOY'
#!/bin/sh
printf 'Alloy %s\nPi    0.82.1\nNode  v22.22.3\n' "${FAKE_ALLOY_VERSION:-1.1.25}"
ALLOY
chmod +x "$ALLOY_PREFIX/bin/alloy"
printf '{"commit":"%s","version":"%s"}\n' "${FAKE_MANIFEST_COMMIT:-$ALLOY_REF}" "${FAKE_MANIFEST_VERSION:-1.1.25}" > "$XDG_DATA_HOME/alloy/install-manifest.json"
""",
        )
        self._executable(
            self.repo / "benchmarks" / "swebench" / ".venv" / "bin" / "python",
            """#!/bin/sh
printf 'CALL\n' >> "$FAKE_RUNNER_LOG"
for argument in "$@"; do printf '%s\n' "$argument" >> "$FAKE_RUNNER_LOG"; done
mkdir -p "$FAKE_RESULT_DIR"
printf '%s\n' '{"status":"fixture-result"}' > "$FAKE_RESULT_DIR/summary.json"
exit "${FAKE_RUNNER_STATUS:-0}"
""",
        )
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_REPO": str(self.repo),
            "FAKE_SHA": SHA,
            "FAKE_REMOTE_SHA": SHA,
            "FAKE_REMOTE_URL": "https://github.com/ccoussa717/alloy.git",
            "FAKE_INSTALLER_LOG": str(self.installer_log),
            "FAKE_RUNNER_LOG": str(self.runner_log),
            "FAKE_RESULT_DIR": str(self.result_dir),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def _executable(self, path: Path, source: str) -> None:
        path.write_text(source)
        path.chmod(0o755)

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

    def _runner_arguments(self) -> list[str]:
        lines = self.runner_log.read_text().splitlines()
        self.assertEqual(lines.count("CALL"), 1)
        return lines[1:]

    def test_wrapper_rejects_dirty_tracked_worktree(self):
        result = self._run(FAKE_STATUS=" M package.json\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clean tracked worktree", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_commit_not_advertised_by_remote(self):
        result = self._run(FAKE_REMOTE_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pushed candidate", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_noncanonical_or_credentialed_remote_url(self):
        for remote_url in (
            "git@gitlab.com:kylaira/alloy.git",
            "https://token@github.com/ccoussa717/alloy.git",
            "https://github.com/ccoussa717/alloy",
        ):
            with self.subTest(remote_url=remote_url):
                result = self._run(FAKE_REMOTE_URL=remote_url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("canonical GitHub remote", result.stderr)
                self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_option_like_remote_name(self):
        result = self._run(ALLOY_BENCH_REMOTE="--upload-pack=payload")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("valid Git remote name", result.stderr)
        self.assertFalse(self.installer_log.exists())

    def test_wrapper_rejects_non_full_lowercase_candidate_sha(self):
        for candidate in ("a" * 12, "A" * 40):
            with self.subTest(candidate=candidate):
                result = self._run(FAKE_SHA=candidate, FAKE_REMOTE_SHA=candidate)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("full lowercase Git SHA", result.stderr)
                self.assertFalse(self.installer_log.exists())

    def test_wrapper_installs_once_into_disposable_isolated_paths(self):
        result = self._run("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        install = self.installer_log.read_text().splitlines()
        self.assertEqual(install[0], "CALL")
        self.assertEqual(install.count("CALL"), 1)
        self.assertEqual(install[1], SHA)
        self.assertEqual(install[2], "main")
        self.assertEqual(Path(install[3]).name, "home")
        self.assertEqual(Path(install[4]).name, "config")
        self.assertEqual(Path(install[5]).name, "cache")
        self.assertEqual(Path(install[6]).name, "data")
        self.assertEqual(Path(install[7]).name, "state")
        self.assertEqual(Path(install[8]).name, "runtime")
        self.assertEqual(Path(install[9]).name, "tmp")
        self.assertEqual(Path(install[10]).name, "prefix")
        self.assertEqual(install[11:], [str(self.repo / "install.sh")])
        self.assertFalse(Path(install[3]).parent.exists())

    def test_wrapper_passes_exact_candidate_arguments_and_dry_run_once(self):
        result = self._run(
            "--dry-run",
            ALLOY_BENCH_REMOTE="release-origin",
            FAKE_EXPECTED_REMOTE="release-origin",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self._runner_arguments()
        temporary_root = Path(self.installer_log.read_text().splitlines()[3]).parent
        self.assertEqual(
            arguments,
            [
                str(self.repo / "benchmarks" / "swebench" / "runner.py"),
                "--profile",
                str(self.repo / "benchmarks" / "swebench" / "profile.json"),
                "--alloy-bin",
                str(temporary_root / "prefix" / "bin" / "alloy"),
                "--candidate-root",
                str(self.repo),
                "--candidate-commit",
                SHA,
                "--install-manifest",
                str(temporary_root / "data" / "alloy" / "install-manifest.json"),
                "--venv-python",
                str(self.repo / "benchmarks" / "swebench" / ".venv" / "bin" / "python"),
                "--dry-run",
            ],
        )

    def test_wrapper_real_mode_preserves_runner_exit_and_result(self):
        result = self._run(FAKE_RUNNER_STATUS="5")
        self.assertEqual(result.returncode, 5)
        self.assertNotIn("--dry-run", self._runner_arguments())
        self.assertIn(str(self.result_dir), result.stdout)
        self.assertEqual(
            (self.result_dir / "summary.json").read_text(),
            '{"status":"fixture-result"}\n',
        )

    def test_wrapper_rejects_installed_version_or_manifest_drift(self):
        cases = (
            {"FAKE_ALLOY_VERSION": "1.1.24"},
            {"FAKE_MANIFEST_VERSION": "1.1.24"},
            {"FAKE_MANIFEST_COMMIT": "b" * 40},
        )
        for environment in cases:
            with self.subTest(environment=environment):
                result = self._run(**environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("installed candidate", result.stderr)
                self.assertFalse(self.runner_log.exists())

    def test_wrapper_does_not_retry_failed_installer(self):
        result = self._run(FAKE_INSTALLER_STATUS="17")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.installer_log.read_text().splitlines().count("CALL"), 1)
        self.assertFalse(self.runner_log.exists())

    def test_wrapper_rejects_unknown_arguments_before_preflight(self):
        result = self._run("--dry-run", "unexpected")
        self.assertEqual(result.returncode, 64)
        self.assertIn("usage:", result.stderr)
        self.assertFalse(self.installer_log.exists())


if __name__ == "__main__":
    unittest.main()
