import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swebench import runner as swebench_runner
from benchmarks.swebench.runner import (
    alloy_command,
    build_prompt,
    capture_patch,
    evaluator_command,
    load_instance,
    official_verdict,
    prediction_record,
    public_instance,
    run_command,
    summarize_run,
    write_prediction_jsonl,
    write_json,
)

EXPECTED_DIGEST = "116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba"
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
PROFILE = swebench_runner.load_profile(PROFILE_PATH)
GOOD_PROVENANCE = {
    "alloy_version": "1.1.25",
    "model_digest": EXPECTED_DIGEST,
    "pi_version": "0.82.1",
    "swebench_version": "5.0.0",
}


class ProfileTests(unittest.TestCase):
    def test_profile_loads_exact_reviewed_inputs_and_rejects_unknown_keys(self):
        profile = swebench_runner.load_profile(PROFILE_PATH)
        self.assertEqual(profile.instance_id, "astropy__astropy-12907")
        self.assertEqual(profile.agent_timeout_seconds, 1800)
        self.assertEqual(profile.swebench_version, "5.0.0")
        with self.assertRaisesRegex(RuntimeError, "unknown profile keys"):
            swebench_runner.parse_profile(
                {**json.loads(PROFILE_PATH.read_text()), "unexpected": True}
            )

    def test_profile_rejects_missing_keys_and_malformed_types(self):
        reviewed = json.loads(PROFILE_PATH.read_text())
        cases = (
            ({key: value for key, value in reviewed.items() if key != "dataset"}, "missing profile keys"),
            ({**reviewed, "dataset": 1}, "profile dataset"),
            ({**reviewed, "agent_timeout_seconds": True}, "agent_timeout_seconds"),
            ({**reviewed, "agent_timeout_seconds": 0}, "positive"),
            ({**reviewed, "base_commit": "ABCDEF" * 7}, "base_commit"),
            ({**reviewed, "model_digest": "A" * 64}, "model_digest"),
        )
        for value, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                swebench_runner.parse_profile(value)

    def test_profile_rejects_non_object_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text("[]\n")
            with self.assertRaisesRegex(RuntimeError, "profile.*object"):
                swebench_runner.load_profile(path)


class CandidateMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.package = self.root / "package.json"
        self.package.write_text(
            json.dumps({"version": "1.1.25", "alloy": {"piFork": {"version": "0.82.1"}}})
        )

    def tearDown(self):
        self.directory.cleanup()

    def test_candidate_metadata_comes_from_source_package_and_full_commit(self):
        metadata = swebench_runner.load_candidate_metadata(
            candidate_root=self.root,
            candidate_commit="a" * 40,
        )
        self.assertEqual(metadata.alloy_version, "1.1.25")
        self.assertEqual(metadata.pi_version, "0.82.1")
        self.assertEqual(metadata.commit, "a" * 40)
        self.assertEqual(metadata.root, self.root)

    def test_candidate_metadata_rejects_short_or_non_lowercase_commit(self):
        for commit in ("abc123", "A" * 40):
            with self.subTest(commit=commit), self.assertRaisesRegex(
                RuntimeError, "full candidate commit"
            ):
                swebench_runner.load_candidate_metadata(self.root, commit)

    def test_candidate_metadata_rejects_missing_or_malformed_source_metadata(self):
        cases = (
            ({"alloy": {"piFork": {"version": "0.82.1"}}}, "Alloy version"),
            ({"version": True, "alloy": {"piFork": {"version": "0.82.1"}}}, "Alloy version"),
            ({"version": "v1", "alloy": {"piFork": {"version": "0.82.1"}}}, "Alloy version"),
            ({"version": "1.1.25"}, "Pi version"),
            ({"version": "1.1.25", "alloy": {"piFork": {"version": 82}}}, "Pi version"),
        )
        for package, message in cases:
            with self.subTest(message=message):
                self.package.write_text(json.dumps(package))
                with self.assertRaisesRegex(RuntimeError, message):
                    swebench_runner.load_candidate_metadata(self.root, "a" * 40)

    def test_install_manifest_is_strict(self):
        path = self.root / "install-manifest.json"
        cases = (
            ({"commit": "a" * 40}, "missing install manifest keys"),
            ({"commit": "A" * 40, "version": "1.1.25"}, "full lowercase Git SHA"),
            ({"commit": "a" * 40, "version": 1}, "version must be semantic"),
            (
                {"commit": "a" * 40, "version": "1.1.25", "unexpected": True},
                "unknown install manifest keys",
            ),
        )
        for manifest, message in cases:
            with self.subTest(message=message):
                path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(RuntimeError, message):
                    swebench_runner.load_install_manifest(path)

        path.write_text(
            json.dumps(
                {
                    "version": "1.1.25",
                    "channel": "ref",
                    "ref": "a" * 40,
                    "commit": "a" * 40,
                    "installedAt": "2026-08-18T00:00:00.000Z",
                    "repository": "ccoussa717/alloy",
                }
            )
        )
        self.assertEqual(
            swebench_runner.load_install_manifest(path),
            {"commit": "a" * 40, "version": "1.1.25"},
        )


class DataContractTests(unittest.TestCase):
    def setUp(self):
        self.row = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "version": "4.3",
            "problem_statement": "Fix the public issue.",
            "patch": "GOLD MUST NOT LEAK",
            "test_patch": "HIDDEN TEST MUST NOT LEAK",
        }

    def test_public_instance_removes_gold_fields(self):
        public = public_instance(self.row)
        self.assertNotIn("patch", public)
        self.assertNotIn("test_patch", public)
        self.assertEqual(public["instance_id"], "astropy__astropy-12907")

    def test_prompt_contains_issue_but_not_gold(self):
        prompt = build_prompt(public_instance(self.row))
        self.assertIn("Fix the public issue.", prompt)
        self.assertNotIn("GOLD MUST NOT LEAK", prompt)
        self.assertIn("inspect the repository", prompt.lower())

    def test_prediction_uses_official_fields(self):
        self.assertEqual(
            prediction_record("id", "alloy/qwen", "diff --git a/x b/x"),
            {
                "instance_id": "id",
                "model_name_or_path": "alloy/qwen",
                "model_patch": "diff --git a/x b/x",
            },
        )

    def test_write_json_is_stable_and_newline_terminated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            write_json(path, {"b": 2, "a": 1})
            self.assertEqual(path.read_text(), '{\n  "a": 1,\n  "b": 2\n}\n')
            self.assertEqual(json.loads(path.read_text()), {"a": 1, "b": 2})


class ProcessBoundaryTests(unittest.TestCase):
    def test_alloy_command_pins_model_and_print_mode(self):
        command = alloy_command(Path("/opt/alloy"), PROFILE.model, "prompt")
        self.assertEqual(
            command,
            [
                "/opt/alloy",
                "--model",
                "ollama/qwen3.8-alloy:latest",
                "-p",
                "prompt",
            ],
        )

    def test_run_alloy_enforces_fixed_timeout(self):
        environment = {"HOME": "/disposable"}
        with mock.patch(
            "benchmarks.swebench.runner.run_command",
            return_value=swebench_runner.CommandResult("", "", 0),
        ) as run:
            swebench_runner.run_alloy(
                Path("/opt/alloy"), PROFILE, Path("/checkout"), "prompt", environment
            )
        run.assert_called_once_with(
            alloy_command(Path("/opt/alloy"), PROFILE.model, "prompt"),
            Path("/checkout"),
            1800,
            env=environment,
        )

    def test_run_command_classifies_timeout(self):
        with self.assertRaises(swebench_runner.CommandTimedOut):
            run_command(
                [sys.executable, "-c", "import time; time.sleep(2)"],
                cwd=Path.cwd(),
                timeout=0.05,
            )

    def test_run_command_preserves_nonzero_output(self):
        with self.assertRaises(swebench_runner.CommandFailed) as raised:
            run_command(
                [
                    sys.executable,
                    "-c",
                    "import sys; print('stdout sentinel'); print('stderr sentinel', file=sys.stderr); sys.exit(7)",
                ],
                cwd=Path.cwd(),
                timeout=5,
            )
        self.assertEqual(raised.exception.stdout, "stdout sentinel\n")
        self.assertEqual(raised.exception.stderr, "stderr sentinel\n")
        self.assertNotIn("stdout sentinel", str(raised.exception))
        self.assertNotIn("stderr sentinel", str(raised.exception))

    def test_run_command_preserves_partial_output_on_timeout(self):
        with self.assertRaises(swebench_runner.CommandTimedOut) as raised:
            run_command(
                [
                    sys.executable,
                    "-c",
                    (
                        "import sys, time; "
                        "print('partial stdout sentinel', flush=True); "
                        "print('partial stderr sentinel', file=sys.stderr, flush=True); "
                        "time.sleep(60)"
                    ),
                ],
                cwd=Path.cwd(),
                timeout=0.1,
            )
        self.assertIn("partial stdout sentinel", raised.exception.stdout)
        self.assertIn("partial stderr sentinel", raised.exception.stderr)
        self.assertNotIn("partial stdout sentinel", str(raised.exception))
        self.assertNotIn("partial stderr sentinel", str(raised.exception))

    def test_run_command_timeout_terminates_descendants(self):
        parent_code = """import pathlib
import signal
import subprocess
import sys
import time

child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(60)", "swebench-runner-timeout-descendant"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

def terminate(_signum, _frame):
    child.terminate()
    child.wait(timeout=5)
    raise SystemExit(0)

signal.signal(signal.SIGTERM, terminate)
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
time.sleep(60)
"""
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / "child.pid"
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                run_command(
                    [sys.executable, "-c", parent_code, str(pid_path)],
                    cwd=Path.cwd(),
                    timeout=1,
                )
            self.assertTrue(pid_path.exists(), "parent did not start its child before timeout")
            child_pid = int(pid_path.read_text())
            child_proc = Path(f"/proc/{child_pid}")
            try:
                deadline = time.monotonic() + 2
                while child_proc.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(child_proc.exists(), f"descendant process {child_pid} survived timeout")
            finally:
                if child_proc.exists():
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_run_command_escalates_for_descendant_that_ignores_sigterm(self):
        parent_code = """import pathlib
import subprocess
import sys
import time

child_code = """ + repr(
            "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
        ) + """
child = subprocess.Popen([sys.executable, "-c", child_code])
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
time.sleep(60)
"""
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / "child.pid"
            child_pid = None
            try:
                with self.assertRaises(swebench_runner.CommandTimedOut):
                    run_command(
                        [sys.executable, "-c", parent_code, str(pid_path)],
                        cwd=Path.cwd(),
                        timeout=1,
                    )
                self.assertTrue(pid_path.exists(), "parent did not start its child before timeout")
                child_pid = int(pid_path.read_text())
                deadline = time.monotonic() + 2
                while Path(f"/proc/{child_pid}").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(
                    Path(f"/proc/{child_pid}").exists(),
                    f"SIGTERM-ignoring descendant {child_pid} survived escalation",
                )
            finally:
                if child_pid is not None and Path(f"/proc/{child_pid}").exists():
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_agent_environment_is_allowlisted_and_disposable(self):
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / ".work" / "run-1" / "agent-state"
            environment = swebench_runner.agent_environment(
                state_root,
                {
                    "PATH": "/usr/bin:/bin",
                    "LANG": "C.UTF-8",
                    "TERM": "xterm-256color",
                    "OLLAMA_HOST": "127.0.0.1:11434",
                    "REVIEW_SECRET_SENTINEL": "must-not-cross-boundary",
                },
            )

            self.assertNotIn("REVIEW_SECRET_SENTINEL", environment)
            self.assertEqual(environment["PATH"], "/usr/bin:/bin")
            self.assertEqual(environment["LANG"], "C.UTF-8")
            self.assertEqual(environment["OLLAMA_HOST"], "127.0.0.1:11434")
            self.assertEqual(environment["HOME"], str(state_root / "home"))
            self.assertEqual(environment["XDG_CONFIG_HOME"], str(state_root / "xdg-config"))
            self.assertEqual(environment["XDG_CACHE_HOME"], str(state_root / "xdg-cache"))
            self.assertEqual(environment["XDG_DATA_HOME"], str(state_root / "xdg-data"))
            self.assertEqual(environment["XDG_STATE_HOME"], str(state_root / "xdg-state"))
            self.assertTrue(all(Path(environment[key]).is_dir() for key in (
                "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"
            )))
            with self.assertRaisesRegex(RuntimeError, "local Ollama"):
                swebench_runner.agent_environment(
                    state_root / "rejected",
                    {"OLLAMA_HOST": "http://credential@localhost:11434"},
                )

    def test_run_alloy_passes_only_sanitized_environment(self):
        secret = "must-not-cross-boundary"
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory) / ".work" / "run-1" / "agent-state"
            with (
                mock.patch.dict(os.environ, {"REVIEW_SECRET_SENTINEL": secret}),
                mock.patch(
                    "benchmarks.swebench.runner.run_command",
                    return_value=swebench_runner.CommandResult("", "", 0),
                ) as run,
            ):
                environment = swebench_runner.agent_environment(state_root)
                swebench_runner.run_alloy(
                    Path("/opt/alloy"), PROFILE, Path("/checkout"), "prompt", environment
                )

        boundary_environment = run.call_args.kwargs["env"]
        self.assertNotIn("REVIEW_SECRET_SENTINEL", boundary_environment)
        self.assertNotIn(secret, boundary_environment.values())
        self.assertEqual(boundary_environment["HOME"], str(state_root / "home"))

    def test_capture_patch_returns_git_diff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.email", "bench@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Benchmark"], cwd=root, check=True)
            (root / "x.txt").write_text("before\n")
            subprocess.run(["git", "add", "x.txt"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=root, check=True)
            (root / "x.txt").write_text("after\n")
            patch = capture_patch(root)
            self.assertIn("-before", patch)
            self.assertIn("+after", patch)

    def test_capture_patch_includes_staged_tracked_modification_and_applies(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "bench@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Benchmark"], cwd=source, check=True)
            (source / "tracked.txt").write_text("before\n")
            subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=source, check=True)
            subprocess.run(["git", "clone", "-q", str(source), str(target)], check=True)
            (source / "tracked.txt").write_text("staged modification\n")
            subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)

            patch = capture_patch(source)
            patch_path = Path(directory) / "model.patch"
            patch_path.write_text(patch)
            subprocess.run(["git", "apply", "--check", str(patch_path)], cwd=target, check=True)

            self.assertIn("+staged modification", patch)

    def test_capture_patch_includes_staged_new_text_and_binary_files_once_and_applies(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "bench@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Benchmark"], cwd=source, check=True)
            (source / ".gitignore").write_text("ignored.bin\n")
            subprocess.run(["git", "add", ".gitignore"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=source, check=True)
            subprocess.run(["git", "clone", "-q", str(source), str(target)], check=True)
            (source / "staged.txt").write_text("staged text sentinel\n")
            (source / "staged.bin").write_bytes(bytes(range(256)) * 8)
            subprocess.run(["git", "add", "staged.txt", "staged.bin"], cwd=source, check=True)

            patch = capture_patch(source)
            patch_path = Path(directory) / "model.patch"
            patch_path.write_text(patch)
            subprocess.run(["git", "apply", "--check", str(patch_path)], cwd=target, check=True)

            self.assertEqual(patch.count("diff --git a/staged.txt b/staged.txt"), 1)
            self.assertEqual(patch.count("diff --git a/staged.bin b/staged.bin"), 1)
            self.assertIn("GIT binary patch", patch)

    def test_capture_patch_includes_mixed_staged_unstaged_and_untracked_state_once(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "bench@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Benchmark"], cwd=source, check=True)
            (source / ".gitignore").write_text("ignored.bin\n")
            (source / "tracked.txt").write_text("base\n")
            subprocess.run(["git", "add", ".gitignore", "tracked.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=source, check=True)
            subprocess.run(["git", "clone", "-q", str(source), str(target)], check=True)
            (source / "tracked.txt").write_text("staged line\n")
            subprocess.run(["git", "add", "tracked.txt"], cwd=source, check=True)
            (source / "tracked.txt").write_text("staged line\nunstaged line\n")
            (source / "staged-new.txt").write_text("staged new\n")
            subprocess.run(["git", "add", "staged-new.txt"], cwd=source, check=True)
            (source / "untracked.bin").write_bytes(b"\x00untracked binary\n")
            (source / "ignored.bin").write_bytes(b"ignored\n")

            patch = capture_patch(source)
            patch_path = Path(directory) / "model.patch"
            patch_path.write_text(patch)
            subprocess.run(["git", "apply", "--check", str(patch_path)], cwd=target, check=True)

            self.assertIn("+staged line", patch)
            self.assertIn("+unstaged line", patch)
            self.assertEqual(patch.count("diff --git a/staged-new.txt b/staged-new.txt"), 1)
            self.assertEqual(patch.count("diff --git a/untracked.bin b/untracked.bin"), 1)
            self.assertNotIn("ignored.bin", patch)

    def test_capture_patch_includes_untracked_but_not_ignored_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / ".gitignore").write_text("ignored.txt\n")
            subprocess.run(["git", "add", ".gitignore"], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.email=bench@example.invalid",
                    "-c",
                    "user.name=Benchmark",
                    "commit",
                    "-qm",
                    "base",
                ],
                cwd=root,
                check=True,
            )
            (root / "created.txt").write_text("new file sentinel\n")
            (root / "ignored.txt").write_text("ignored sentinel\n")

            patch = capture_patch(root)

            self.assertIn("created.txt", patch)
            self.assertIn("new file sentinel", patch)
            self.assertNotIn("ignored.txt", patch)
            self.assertNotIn("ignored sentinel", patch)

    def test_capture_patch_bounds_untracked_diff_and_accepts_exit_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "created.bin").write_bytes(b"\x00binary sentinel\n")
            results = [
                swebench_runner.CommandResult("", "", 0),
                swebench_runner.CommandResult("created.bin\0", "", 0),
                swebench_runner.CommandResult("bounded binary patch", "", 1),
            ]

            with mock.patch.object(swebench_runner, "_run_command", side_effect=results) as bounded:
                patch = capture_patch(root)

            self.assertEqual(patch, "bounded binary patch")
            self.assertEqual(
                bounded.call_args_list[0],
                mock.call(
                    ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
                    root,
                    120,
                    frozenset({0}),
                    env=None,
                ),
            )
            self.assertEqual(
                bounded.call_args_list[-1],
                mock.call(
                    [
                        "git",
                        "diff",
                        "--binary",
                        "--no-ext-diff",
                        "--no-index",
                        "--",
                        "/dev/null",
                        "created.bin",
                    ],
                    root,
                    120,
                    frozenset({0, 1}),
                ),
            )

    def test_capture_patch_real_untracked_binary_applies_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "source"
            target = Path(directory) / "target"
            root.mkdir()
            target.mkdir()
            for repository in (root, target):
                subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
                (repository / ".gitignore").write_text("ignored.bin\n")
                subprocess.run(["git", "add", ".gitignore"], cwd=repository, check=True)
                subprocess.run(
                    [
                        "git", "-c", "user.email=bench@example.invalid",
                        "-c", "user.name=Benchmark", "commit", "-qm", "base",
                    ],
                    cwd=repository,
                    check=True,
                )
            (root / "created.bin").write_bytes(bytes(range(256)) * 8)

            patch = capture_patch(root)

            self.assertIn("GIT binary patch", patch)
            patch_path = Path(directory) / "model.patch"
            patch_path.write_text(patch)
            subprocess.run(["git", "apply", "--check", str(patch_path)], cwd=target, check=True)


class OrchestrationTests(unittest.TestCase):
    def candidate_args(self, root: Path) -> list[str]:
        candidate_root = root / "candidate"
        candidate_root.mkdir(exist_ok=True)
        (candidate_root / "package.json").write_text(
            json.dumps({"version": "1.1.25", "alloy": {"piFork": {"version": "0.82.1"}}})
        )
        install_manifest = root / "install-manifest.json"
        install_manifest.write_text(json.dumps({"commit": "a" * 40, "version": "1.1.25"}))
        return [
            "--profile", str(PROFILE_PATH),
            "--alloy-bin", str(root / "bin" / "alloy"),
            "--candidate-root", str(candidate_root),
            "--candidate-commit", "a" * 40,
            "--install-manifest", str(install_manifest),
        ]

    def test_load_instance_returns_only_pinned_public_row(self):
        rows = [
            {
                "instance_id": "astropy__astropy-12907",
                "repo": "astropy/astropy",
                "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
                "version": "4.3",
                "problem_statement": "Fix the public issue.",
                "patch": "gold",
                "test_patch": "hidden",
            }
        ]
        with mock.patch("benchmarks.swebench.runner.load_dataset", return_value=rows):
            instance = load_instance(PROFILE)
        self.assertEqual(instance["instance_id"], "astropy__astropy-12907")
        self.assertEqual(instance["base_commit"], "d16bfe05a744909de4b27f5875fe0d4ed41ce607")
        self.assertNotIn("patch", instance)
        self.assertNotIn("test_patch", instance)

    def test_load_instance_rejects_commit_drift(self):
        row = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "wrong",
            "problem_statement": "Fix the public issue.",
        }
        with mock.patch("benchmarks.swebench.runner.load_dataset", return_value=[row]):
            with self.assertRaisesRegex(RuntimeError, "base commit"):
                load_instance(PROFILE)

    def test_prediction_jsonl_is_one_line(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "predictions.jsonl"
            write_prediction_jsonl(path, prediction_record("id", "model", "patch"))
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["model_patch"], "patch")

    def test_evaluator_command_is_pinned_to_one_instance(self):
        command = evaluator_command(
            PROFILE, Path("/venv/python"), Path("predictions.jsonl"), "run-1"
        )
        self.assertIn("SWE-bench/SWE-bench_Lite", command)
        self.assertEqual(command[command.index("--instance_ids") + 1], "astropy__astropy-12907")
        self.assertEqual(command[command.index("--max_workers") + 1], "1")

    def test_runtime_probe_parses_installed_alloy_and_pi_versions(self):
        environment = {"HOME": "/disposable"}
        with mock.patch(
            "benchmarks.swebench.runner.run_command",
            return_value=swebench_runner.CommandResult(
                "Alloy 1.1.25\nPi    0.82.1\nNode  v22.22.3\n",
                "",
                0,
            ),
        ) as run:
            versions = swebench_runner.probe_runtime_versions(Path("/opt/alloy"), environment)

        self.assertEqual(versions, {"alloy_version": "1.1.25", "pi_version": "0.82.1"})
        run.assert_called_once_with(
            ["/opt/alloy", "--version"],
            swebench_runner.REPO_ROOT,
            30,
            env=environment,
        )

    def test_swebench_probe_uses_executing_python_and_parses_exact_version(self):
        environment = {"HOME": "/disposable"}
        with mock.patch(
            "benchmarks.swebench.runner.run_command",
            return_value=swebench_runner.CommandResult("5.0.0\n", "", 0),
        ) as run:
            version = swebench_runner.probe_swebench_version(Path("/venv/python"), environment)

        self.assertEqual(version, "5.0.0")
        self.assertEqual(run.call_args.args[:2], (
            [
                "/venv/python",
                "-c",
                "import importlib.metadata; print(importlib.metadata.version('swebench'))",
            ],
            swebench_runner.REPO_ROOT,
        ))
        self.assertEqual(run.call_args.kwargs["env"], environment)

    def test_ollama_probe_records_exact_digest_and_rejects_missing_model(self):
        tags = {
            "models": [
                {"name": "qwen3.8-alloy:latest", "digest": EXPECTED_DIGEST},
                {"name": "other:latest", "digest": "f" * 64},
            ]
        }
        self.assertEqual(swebench_runner.model_digest_from_tags(PROFILE, tags), EXPECTED_DIGEST)
        with self.assertRaisesRegex(RuntimeError, "qwen3.8-alloy:latest.*not installed"):
            swebench_runner.model_digest_from_tags(PROFILE, {"models": []})

    def test_live_provenance_combines_mocked_local_probes(self):
        environment = {"HOME": "/disposable", "OLLAMA_HOST": "127.0.0.1:11434"}
        with (
            mock.patch(
                "benchmarks.swebench.runner.probe_runtime_versions",
                return_value={"alloy_version": "1.1.25", "pi_version": "0.82.1"},
            ) as runtime,
            mock.patch(
                "benchmarks.swebench.runner.probe_ollama_model_digest", return_value=EXPECTED_DIGEST
            ) as model,
            mock.patch("benchmarks.swebench.runner.probe_swebench_version", return_value="5.0.0") as package,
        ):
            provenance = swebench_runner.probe_live_provenance(
                Path("/opt/alloy"), PROFILE, Path("/venv/python"), environment
            )

        self.assertEqual(provenance, GOOD_PROVENANCE)
        runtime.assert_called_once_with(Path("/opt/alloy"), environment)
        model.assert_called_once_with(PROFILE, environment)
        package.assert_called_once_with(Path("/venv/python"), environment)

    def test_official_verdict_reads_schema_v2_benchmark_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = root / "official-summary.json"
            write_json(summary, {"schema_version": 2, "resolved_ids": ["astropy__astropy-12907"]})
            self.assertEqual(official_verdict(PROFILE, root), "resolved")
            for category in ("unresolved_ids", "empty_patch_ids"):
                with self.subTest(category=category):
                    write_json(summary, {"schema_version": 2, category: ["astropy__astropy-12907"]})
                    self.assertEqual(official_verdict(PROFILE, root), "unresolved")

    def test_official_verdict_rejects_schema_v2_infrastructure_categories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = root / "official-summary.json"
            for category in ("infra_failure_ids", "ambiguous_failure_ids", "error_ids"):
                with self.subTest(category=category):
                    write_json(
                        summary,
                        {
                            "schema_version": 2,
                            "unresolved_ids": ["astropy__astropy-12907"],
                            category: ["astropy__astropy-12907"],
                        },
                    )
                    with self.assertRaisesRegex(RuntimeError, category):
                        official_verdict(PROFILE, root)

    def test_official_verdict_rejects_malformed_relevant_category_values(self):
        categories = (
            "infra_failure_ids",
            "ambiguous_failure_ids",
            "error_ids",
            "resolved_ids",
            "unresolved_ids",
            "empty_patch_ids",
        )
        malformed = ("astropy__astropy-12907", ["valid", 7], {}, None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = root / "official-summary.json"
            for category in categories:
                for value in malformed:
                    with self.subTest(category=category, value=value):
                        write_json(summary, {"schema_version": 2, category: value})
                        with self.assertRaisesRegex(RuntimeError, category):
                            official_verdict(PROFILE, root)

    def test_official_verdict_rejects_resolved_and_unresolved_contradictions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = root / "official-summary.json"
            for category in ("unresolved_ids", "empty_patch_ids"):
                with self.subTest(category=category):
                    write_json(
                        summary,
                        {
                            "schema_version": 2,
                            "resolved_ids": [PROFILE.instance_id],
                            category: [PROFILE.instance_id],
                        },
                    )
                    with self.assertRaisesRegex(RuntimeError, "contradictory"):
                        official_verdict(PROFILE, root)

    def test_official_verdict_preserves_infrastructure_precedence_over_contradiction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(
                root / "official-summary.json",
                {
                    "schema_version": 2,
                    "infra_failure_ids": [PROFILE.instance_id],
                    "resolved_ids": [PROFILE.instance_id],
                    "unresolved_ids": [PROFILE.instance_id],
                },
            )
            with self.assertRaisesRegex(RuntimeError, "infra_failure_ids"):
                official_verdict(PROFILE, root)

    def test_official_verdict_accepts_unrelated_fields_and_empty_patch_unresolved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_json(
                root / "official-summary.json",
                {
                    "schema_version": 2,
                    "empty_patch_ids": [PROFILE.instance_id],
                    "official_metadata": {"count": 1},
                },
            )
            self.assertEqual(official_verdict(PROFILE, root), "unresolved")

    def test_evaluator_uses_disposable_scratch_and_persists_only_safe_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work_root = root / ".work"
            evaluation_dir = root / "results" / "run-1" / "evaluation"
            predictions = root / "results" / "run-1" / "predictions.jsonl"
            write_prediction_jsonl(predictions, prediction_record("id", "model", "patch"))
            observed_cwds = []

            def fake_run(command, cwd, timeout):
                observed_cwds.append(cwd)
                (cwd / "eval.sh").write_text("HIDDEN TEST MATERIAL")
                hidden = cwd / "logs" / "run_evaluation" / "hidden"
                hidden.mkdir(parents=True)
                (hidden / "test_output.txt").write_text("HIDDEN TEST OUTPUT")
                write_json(
                    cwd / "model.run-1.json",
                    {
                        "schema_version": 2,
                        "resolved_ids": ["astropy__astropy-12907"],
                    },
                )
                return swebench_runner.CommandResult("official stdout", "official stderr", 0)

            with mock.patch("benchmarks.swebench.runner.run_command", side_effect=fake_run):
                verdict = swebench_runner.run_official_evaluation(
                    PROFILE,
                    Path("/venv/python"),
                    predictions,
                    "run-1",
                    work_root,
                    evaluation_dir,
                )

            self.assertEqual(verdict, "resolved")
            self.assertEqual(len(observed_cwds), 1)
            self.assertEqual(observed_cwds[0].parent, work_root)
            self.assertFalse(observed_cwds[0].exists())
            self.assertEqual(
                sorted(path.name for path in evaluation_dir.iterdir()),
                ["official-summary.json", "stderr.log", "stdout.log"],
            )
            self.assertEqual((evaluation_dir / "stdout.log").read_text(), "official stdout")
            self.assertEqual((evaluation_dir / "stderr.log").read_text(), "official stderr")
            self.assertFalse(any(path.name == "eval.sh" for path in root.rglob("*")))
            self.assertNotIn("HIDDEN TEST", (evaluation_dir / "official-summary.json").read_text())

    def test_evaluator_nonzero_and_timeout_persist_partial_streams(self):
        cases = (
            (
                "nonzero",
                lambda: swebench_runner.CommandFailed(
                    command=["/venv/python", "-m", "swebench.harness.run_evaluation"],
                    stdout="evaluator nonzero stdout\n",
                    stderr="evaluator nonzero stderr\n",
                    returncode=9,
                ),
            ),
            (
                "timeout",
                lambda: swebench_runner.CommandTimedOut(
                    command=["/venv/python", "-m", "swebench.harness.run_evaluation"],
                    stdout="evaluator timeout partial stdout\n",
                    stderr="evaluator timeout partial stderr\n",
                    timeout=2400,
                ),
            ),
        )
        for name, failure in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                predictions = root / "predictions.jsonl"
                predictions.write_text("{}\n")
                evaluation_dir = root / "results" / "evaluation"
                with mock.patch("benchmarks.swebench.runner.run_command", side_effect=failure()):
                    with self.assertRaises(swebench_runner.CommandError) as raised:
                        swebench_runner.run_official_evaluation(
                            PROFILE,
                            Path("/venv/python"),
                            predictions,
                            "run-1",
                            root / ".work",
                            evaluation_dir,
                        )

                self.assertEqual(
                    (evaluation_dir / "stdout.log").read_text(), raised.exception.stdout
                )
                self.assertEqual(
                    (evaluation_dir / "stderr.log").read_text(), raised.exception.stderr
                )
                self.assertNotIn(raised.exception.stdout.strip(), str(raised.exception))
                self.assertNotIn(raised.exception.stderr.strip(), str(raised.exception))

    def test_summarize_run_adds_completion_timestamp_and_elapsed_time(self):
        with mock.patch("benchmarks.swebench.runner.utc_now", return_value="2026-08-18T06:00:02.500000+00:00"):
            summary = summarize_run(
                "run-1",
                "agent_failure",
                "2026-08-18T06:00:00+00:00",
                error="boom",
            )
        self.assertEqual(summary["completed_at"], "2026-08-18T06:00:02.500000+00:00")
        self.assertEqual(summary["elapsed_seconds"], 2.5)
        self.assertEqual(summary["status"], "agent_failure")
        self.assertEqual(summary["error"], "boom")

    def test_create_run_dir_retries_readable_timestamp_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base_id = "alloy-1.1.25-20260818T060000123456Z"
            (root / base_id).mkdir()
            with mock.patch("benchmarks.swebench.runner.datetime") as clock:
                clock.now.return_value.strftime.return_value = base_id
                run_id, run_dir = swebench_runner.create_run_dir(root, "1.1.25")

            self.assertEqual(run_id, f"{base_id}-01")
            self.assertEqual(run_dir, root / run_id)
            self.assertTrue(run_dir.is_dir())

    def test_run_path_pointer_records_exact_invocation_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "results" / "run-1"
            run_dir.mkdir(parents=True)
            pointer = root / "state" / "run-path.json"

            swebench_runner.write_run_path_pointer(
                pointer,
                run_dir,
                "run-1",
                "a" * 40,
                "token-123",
            )

            self.assertEqual(
                json.loads(pointer.read_text()),
                {
                    "candidate_commit": "a" * 40,
                    "results_root": str(run_dir.parent.resolve()),
                    "run_dir": str(run_dir.resolve()),
                    "run_id": "run-1",
                    "run_token": "token-123",
                    "schema_version": 1,
                },
            )

    def test_main_uses_explicit_candidate_binary_and_metadata(self):
        instance = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "problem_statement": "Fix the public issue.",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "results" / "run-1"
            run_dir.mkdir(parents=True)
            run_path_pointer = root / "state" / "run-path.json"
            venv_python = root / "venv" / "bin" / "python"
            venv_python.parent.mkdir(parents=True)
            venv_python.symlink_to(sys.executable)

            def provenance_after_pointer(*_args, **_kwargs):
                self.assertTrue(run_path_pointer.is_file())
                return GOOD_PROVENANCE

            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch(
                    "benchmarks.swebench.runner.probe_live_provenance",
                    side_effect=provenance_after_pointer,
                ),
                mock.patch("benchmarks.swebench.runner.load_instance", return_value=instance),
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=[
                        "2026-08-18T06:00:00+00:00",
                        "2026-08-18T06:00:03+00:00",
                    ],
                ),
            ):
                result = swebench_runner.main(
                    self.candidate_args(root) + [
                        "--results-root",
                        str(root / "results"),
                        "--work-root",
                        str(root / "work"),
                        "--venv-python",
                        str(venv_python),
                        "--run-path-file",
                        str(run_path_pointer),
                        "--run-token",
                        "token-123",
                        "--dry-run",
                    ]
                )

            self.assertEqual(result, 0)
            self.assertEqual(
                json.loads(run_path_pointer.read_text())["run_dir"],
                str(run_dir.resolve()),
            )
            manifest = json.loads((run_dir / "manifest.json").read_text())
            self.assertEqual(manifest["alloy_version"], "1.1.25")
            self.assertEqual(manifest["pi_version"], "0.82.1")
            self.assertEqual(manifest["model_digest"], EXPECTED_DIGEST)
            self.assertEqual(manifest["expected_model_digest"], EXPECTED_DIGEST)
            self.assertEqual(manifest["swebench_version"], "5.0.0")
            self.assertEqual(manifest["expected_swebench_version"], "5.0.0")
            self.assertEqual(manifest["model"], "ollama/qwen3.8-alloy:latest")
            self.assertEqual(manifest["instance_id"], "astropy__astropy-12907")
            self.assertEqual(manifest["base_commit"], instance["base_commit"])
            self.assertEqual(manifest["dataset"], "SWE-bench/SWE-bench_Lite")
            self.assertEqual(manifest["run_id"], "run-1")
            self.assertEqual(manifest["started_at"], "2026-08-18T06:00:00+00:00")
            self.assertEqual(manifest["timeout_seconds"], 1800)
            self.assertEqual(
                manifest["commands"]["alloy"],
                [
                    str(root / "bin" / "alloy"),
                    "--model",
                    "ollama/qwen3.8-alloy:latest",
                    "-p",
                    "<problem.md contents>",
                ],
            )
            self.assertEqual(
                manifest["commands"]["runtime_probe"],
                [str(root / "bin" / "alloy"), "--version"],
            )
            self.assertEqual(manifest["candidate_commit"], "a" * 40)
            self.assertEqual(manifest["candidate_source_root"], str((root / "candidate").resolve()))
            self.assertEqual(
                manifest["install_manifest"], {"commit": "a" * 40, "version": "1.1.25"}
            )
            self.assertEqual(
                manifest["commands"]["evaluator"][0],
                str(venv_python),
            )
            self.assertNotIn("environment", manifest["commands"])
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "dry_run")
            self.assertEqual(summary["completed_at"], "2026-08-18T06:00:03+00:00")
            self.assertEqual(summary["elapsed_seconds"], 3.0)

    def test_dataset_failure_writes_timed_status_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run-1"
            run_dir.mkdir()
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch(
                    "benchmarks.swebench.runner.probe_live_provenance",
                    return_value=GOOD_PROVENANCE,
                ),
                mock.patch("benchmarks.swebench.runner.load_instance", side_effect=RuntimeError("dataset down")),
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(self.candidate_args(Path(directory)) + ["--dry-run"])

            self.assertEqual(result, 3)
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "dataset_failure")
            self.assertEqual(summary["completed_at"], "2026-08-18T06:00:01+00:00")
            self.assertEqual(summary["elapsed_seconds"], 1.0)
            manifest = json.loads((run_dir / "manifest.json").read_text())
            self.assertEqual(manifest["alloy_version"], "1.1.25")
            self.assertEqual(manifest["pi_version"], "0.82.1")

    def test_runtime_version_drift_fails_before_dataset_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run-1"
            run_dir.mkdir()
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch(
                    "benchmarks.swebench.runner.probe_live_provenance",
                    return_value={**GOOD_PROVENANCE, "alloy_version": "1.2.0"},
                ),
                mock.patch("benchmarks.swebench.runner.load_instance") as load,
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(self.candidate_args(Path(directory)) + ["--dry-run"])

            self.assertEqual(result, 2)
            load.assert_not_called()
            manifest = json.loads((run_dir / "manifest.json").read_text())
            self.assertEqual(manifest["alloy_version"], "1.2.0")
            self.assertEqual(manifest["expected_alloy_version"], "1.1.25")
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "runtime_failure")
            self.assertIn("Alloy version drift", summary["error"])

    def test_candidate_install_and_pi_drift_fail_before_dataset_loading(self):
        cases = (
            ("install_commit", "b" * 40, GOOD_PROVENANCE, "installed candidate commit drift"),
            ("install_version", "1.2.0", GOOD_PROVENANCE, "installed Alloy version drift"),
            (
                "pi_version",
                None,
                {**GOOD_PROVENANCE, "pi_version": "0.83.0"},
                "Pi version drift",
            ),
        )
        for field, observed, provenance, message in cases:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                run_dir = root / "run-1"
                run_dir.mkdir()
                args = self.candidate_args(root) + ["--dry-run"]
                install_path = root / "install-manifest.json"
                install = json.loads(install_path.read_text())
                if field == "install_commit":
                    install["commit"] = observed
                elif field == "install_version":
                    install["version"] = observed
                install_path.write_text(json.dumps(install))
                with (
                    mock.patch(
                        "benchmarks.swebench.runner.create_run_dir",
                        return_value=("run-1", run_dir),
                    ),
                    mock.patch(
                        "benchmarks.swebench.runner.probe_live_provenance",
                        return_value=provenance,
                    ),
                    mock.patch("benchmarks.swebench.runner.load_instance") as load,
                    mock.patch(
                        "benchmarks.swebench.runner.utc_now",
                        side_effect=[
                            "2026-08-18T06:00:00+00:00",
                            "2026-08-18T06:00:01+00:00",
                        ],
                    ),
                ):
                    result = swebench_runner.main(args)

                self.assertEqual(result, 2)
                load.assert_not_called()
                summary = json.loads((run_dir / "summary.json").read_text())
                self.assertIn(message, summary["error"])

    def test_model_digest_and_swebench_version_drift_fail_before_dataset_loading(self):
        cases = (
            (
                "model_digest",
                "0" * 64,
                "Ollama model digest drift",
            ),
            (
                "swebench_version",
                "5.1.0",
                "SWE-bench version drift",
            ),
        )
        for field, observed, message in cases:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                run_dir = Path(directory) / "run-1"
                run_dir.mkdir()
                with (
                    mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                    mock.patch(
                        "benchmarks.swebench.runner.probe_live_provenance",
                        return_value={**GOOD_PROVENANCE, field: observed},
                    ),
                    mock.patch("benchmarks.swebench.runner.load_instance") as load,
                    mock.patch(
                        "benchmarks.swebench.runner.utc_now",
                        side_effect=[
                            "2026-08-18T06:00:00+00:00",
                            "2026-08-18T06:00:01+00:00",
                        ],
                    ),
                ):
                    result = swebench_runner.main(
                        self.candidate_args(Path(directory)) + ["--dry-run"]
                    )

                self.assertEqual(result, 2)
                load.assert_not_called()
                summary = json.loads((run_dir / "summary.json").read_text())
                self.assertIn(message, summary["error"])

    def test_missing_ollama_model_fails_before_dataset_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run-1"
            run_dir.mkdir()
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch(
                    "benchmarks.swebench.runner.probe_live_provenance",
                    side_effect=RuntimeError("Ollama model qwen3.8-alloy:latest is not installed"),
                ),
                mock.patch("benchmarks.swebench.runner.load_instance") as load,
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(self.candidate_args(Path(directory)) + ["--dry-run"])

            self.assertEqual(result, 2)
            load.assert_not_called()
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertIn("not installed", summary["error"])

    def test_cli_rejects_configurable_agent_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run-1"
            run_dir.mkdir()
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch("benchmarks.swebench.runner.load_instance"),
                mock.patch("benchmarks.swebench.runner.utc_now", return_value="2026-08-18T06:00:00+00:00"),
            ):
                with self.assertRaises(SystemExit):
                    swebench_runner.main(
                        self.candidate_args(Path(directory))
                        + ["--agent-timeout", "42", "--dry-run"]
                    )

    def test_cli_rejects_real_execution_before_loading_profile(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch(
            "benchmarks.swebench.runner.load_profile",
            side_effect=AssertionError("profile must not load"),
        ) as load:
            result = swebench_runner.main(self.candidate_args(Path(directory)))

        self.assertEqual(result, 2)
        load.assert_not_called()

    def test_default_paths_are_anchored_to_runner_from_external_cwd(self):
        instance = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "problem_statement": "Fix the public issue.",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "run-1"
            run_dir.mkdir()

            def fake_evaluator(command, cwd, timeout):
                write_json(
                    cwd / "model.run-1.json",
                    {
                        "schema_version": 2,
                        "unresolved_ids": ["astropy__astropy-12907"],
                    },
                )
                return swebench_runner.CommandResult("", "", 0)

            previous_cwd = Path.cwd()
            try:
                os.chdir(root)
                with (
                    mock.patch(
                        "benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)
                    ) as create,
                    mock.patch(
                        "benchmarks.swebench.runner.probe_live_provenance",
                        return_value=GOOD_PROVENANCE,
                    ),
                    mock.patch("benchmarks.swebench.runner.load_instance", return_value=instance),
                    mock.patch("benchmarks.swebench.runner.checkout_instance") as checkout,
                    mock.patch(
                        "benchmarks.swebench.runner.run_alloy",
                        return_value=swebench_runner.CommandResult("", "", 0),
                    ) as alloy,
                    mock.patch("benchmarks.swebench.runner.capture_patch", return_value="patch"),
                    mock.patch("benchmarks.swebench.runner.run_command", side_effect=fake_evaluator),
                    mock.patch(
                        "benchmarks.swebench.runner.utc_now",
                        side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                    ),
                ):
                    result = swebench_runner.main(
                        self.candidate_args(root),
                        _allow_unsafe_execution_for_tests=True,
                    )
            finally:
                os.chdir(previous_cwd)

            self.assertEqual(result, 0)
            bench_root = swebench_runner.BENCH_ROOT
            create.assert_called_once_with(bench_root / "results", "1.1.25")
            self.assertEqual(checkout.call_args.args[2], bench_root / ".work" / "run-1" / "checkout")
            self.assertEqual(alloy.call_count, 1)
            manifest = json.loads((run_dir / "manifest.json").read_text())
            self.assertEqual(
                manifest["commands"]["evaluator"][0],
                str(bench_root / ".venv" / "bin" / "python"),
            )
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "evaluated")
            self.assertEqual(summary["verdict"], "unresolved")

    def test_agent_nonzero_with_timeout_words_is_failure_and_writes_logs(self):
        failure = lambda: swebench_runner.CommandFailed(
            command=["/candidate/bin/alloy", "-p", "prompt"],
            stdout="request timed out but child exited fast\n",
            stderr="agent nonzero stderr\n",
            returncode=7,
        )
        self._assert_agent_failure_artifacts(failure(), "agent_failure", 6)

    def test_actual_agent_timeout_is_typed_and_writes_partial_logs(self):
        failure = lambda: swebench_runner.CommandTimedOut(
            command=["/candidate/bin/alloy", "-p", "prompt"],
            stdout="agent timeout partial stdout\n",
            stderr="agent timeout partial stderr\n",
            timeout=1800,
        )
        self._assert_agent_failure_artifacts(failure(), "agent_timeout", 5)

    def _assert_agent_failure_artifacts(self, failure, expected_status, expected_code):
        instance = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "problem_statement": "Fix the public issue.",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "results" / "run-1"
            run_dir.mkdir(parents=True)
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch("benchmarks.swebench.runner.probe_live_provenance", return_value=GOOD_PROVENANCE),
                mock.patch("benchmarks.swebench.runner.load_instance", return_value=instance),
                mock.patch("benchmarks.swebench.runner.checkout_instance"),
                mock.patch("benchmarks.swebench.runner.run_alloy", side_effect=failure),
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(
                    self.candidate_args(root) + [
                        "--results-root", str(root / "results"),
                        "--work-root", str(root / ".work"),
                        "--venv-python", str(root / ".venv" / "bin" / "python"),
                    ],
                    _allow_unsafe_execution_for_tests=True,
                )

            self.assertEqual(result, expected_code)
            self.assertEqual((run_dir / "alloy.stdout.log").read_text(), failure.stdout)
            self.assertEqual((run_dir / "alloy.stderr.log").read_text(), failure.stderr)
            summary_text = (run_dir / "summary.json").read_text()
            summary = json.loads(summary_text)
            self.assertEqual(summary["status"], expected_status)
            self.assertNotIn(failure.stdout.strip(), summary_text)
            self.assertNotIn(failure.stderr.strip(), summary_text)

    def test_official_infrastructure_category_sets_evaluator_failure_exit(self):
        instance = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "problem_statement": "Fix the public issue.",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "results" / "run-1"
            run_dir.mkdir(parents=True)
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch(
                    "benchmarks.swebench.runner.probe_live_provenance",
                    return_value=GOOD_PROVENANCE,
                ),
                mock.patch("benchmarks.swebench.runner.load_instance", return_value=instance),
                mock.patch("benchmarks.swebench.runner.checkout_instance"),
                mock.patch(
                    "benchmarks.swebench.runner.run_alloy",
                    return_value=swebench_runner.CommandResult("", "", 0),
                ),
                mock.patch("benchmarks.swebench.runner.capture_patch", return_value="patch"),
                mock.patch(
                    "benchmarks.swebench.runner.run_official_evaluation",
                    side_effect=RuntimeError(
                        "official evaluator classified astropy__astropy-12907 in infra_failure_ids"
                    ),
                ),
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(
                    self.candidate_args(root) + [
                        "--results-root",
                        str(root / "results"),
                        "--work-root",
                        str(root / ".work"),
                        "--venv-python",
                        str(root / ".venv" / "bin" / "python"),
                    ],
                    _allow_unsafe_execution_for_tests=True,
                )

            self.assertEqual(result, 8)
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "evaluator_failure")
            self.assertIn("infra_failure_ids", summary["error"])

    def test_evaluator_timeout_sets_typed_timeout_status(self):
        instance = {
            "instance_id": "astropy__astropy-12907",
            "repo": "astropy/astropy",
            "base_commit": "d16bfe05a744909de4b27f5875fe0d4ed41ce607",
            "problem_statement": "Fix the public issue.",
        }
        timeout = swebench_runner.CommandTimedOut(
            command=["/venv/python", "-m", "swebench.harness.run_evaluation"],
            stdout="partial evaluator stdout\n",
            stderr="partial evaluator stderr\n",
            timeout=2400,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_dir = root / "results" / "run-1"
            run_dir.mkdir(parents=True)
            with (
                mock.patch("benchmarks.swebench.runner.create_run_dir", return_value=("run-1", run_dir)),
                mock.patch("benchmarks.swebench.runner.probe_live_provenance", return_value=GOOD_PROVENANCE),
                mock.patch("benchmarks.swebench.runner.load_instance", return_value=instance),
                mock.patch("benchmarks.swebench.runner.checkout_instance"),
                mock.patch(
                    "benchmarks.swebench.runner.run_alloy",
                    return_value=swebench_runner.CommandResult("", "", 0),
                ),
                mock.patch("benchmarks.swebench.runner.capture_patch", return_value="patch"),
                mock.patch("benchmarks.swebench.runner.run_official_evaluation", side_effect=timeout),
                mock.patch(
                    "benchmarks.swebench.runner.utc_now",
                    side_effect=["2026-08-18T06:00:00+00:00", "2026-08-18T06:00:01+00:00"],
                ),
            ):
                result = swebench_runner.main(
                    self.candidate_args(root) + [
                        "--results-root", str(root / "results"),
                        "--work-root", str(root / ".work"),
                        "--venv-python", str(root / ".venv" / "bin" / "python"),
                    ],
                    _allow_unsafe_execution_for_tests=True,
                )

            self.assertEqual(result, 8)
            summary = json.loads((run_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "evaluator_timeout")


if __name__ == "__main__":
    unittest.main()
