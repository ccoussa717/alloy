import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swebench.evaluator import (
    EvaluatorEnvironment,
    install_locked_requirements,
    locked_distributions,
)
from benchmarks.swebench.profile import load_profile


REPO_ROOT = Path(__file__).parents[3]
BENCH_ROOT = Path(__file__).parents[1]
PROFILE_PATH = BENCH_ROOT / "profile.json"
LOCK_PATH = BENCH_ROOT / "requirements.lock"
PATCH_PATH = BENCH_ROOT / "patches" / "swebench-5.0.0-run-evaluation.patch"
PROFILE = load_profile(PROFILE_PATH, REPO_ROOT)
VENV_PYTHON = BENCH_ROOT / ".venv" / "bin" / "python"


class EvaluatorLockTests(unittest.TestCase):
    def test_lock_is_complete_hash_locked_swebench_500_closure(self):
        distributions = locked_distributions(LOCK_PATH)
        self.assertEqual(distributions["swebench"], "5.0.0")
        self.assertGreater(len(distributions), 20)
        logical = re.sub(r"\\\n\s+", " ", LOCK_PATH.read_text())
        entries = [
            block.strip()
            for block in logical.splitlines()
            if block.strip() and not block.strip().startswith("#")
        ]
        for entry in entries:
            with self.subTest(entry=entry):
                self.assertRegex(entry, r"^[a-z0-9][a-z0-9._-]*==[^ ]+(?:\s+--hash=sha256:[0-9a-f]{64})+$")

    def test_profile_records_exact_lock_and_evaluator_source_hashes(self):
        self.assertEqual(
            hashlib.sha256(LOCK_PATH.read_bytes()).hexdigest(),
            PROFILE.evaluator.requirements_lock_sha256,
        )
        self.assertRegex(PROFILE.evaluator.upstream_run_evaluation_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(PROFILE.evaluator.patched_run_evaluation_sha256, r"^[0-9a-f]{64}$")
        self.assertEqual(PROFILE.evaluator.python_version, "3.14.4")

    def test_install_uses_pip_require_hashes_and_never_requirements_txt(self):
        with mock.patch("benchmarks.swebench.evaluator.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "", "")
            install_locked_requirements(Path("/venv/bin/python"), LOCK_PATH)
        command = run.call_args.args[0]
        self.assertEqual(
            command,
            [
                "/venv/bin/python",
                "-m",
                "pip",
                "install",
                "--require-hashes",
                "-r",
                str(LOCK_PATH.resolve()),
            ],
        )
        self.assertNotIn("requirements.txt", " ".join(command))

    def test_requirements_txt_is_non_executable_pointer_only(self):
        text = (BENCH_ROOT / "requirements.txt").read_text()
        self.assertEqual(text, "# Install with --require-hashes from requirements.lock.\n")

    def test_designated_environment_installed_distributions_equal_lock(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, VENV_PYTHON)
        installed = environment._installed_distributions()
        installed.pop("pip", None)
        self.assertEqual(installed, locked_distributions(LOCK_PATH))


class EvaluatorConfinementTests(unittest.TestCase):
    def test_patch_is_confinement_only_and_has_no_sys_admin_or_fuzz(self):
        patch = PATCH_PATH.read_text()
        self.assertIn('cap_drop=["ALL"]', patch)
        self.assertIn("network_disabled=True", patch)
        self.assertIn("no-new-privileges", patch)
        self.assertIn("alloy-swebench-gate", patch)
        self.assertIn("pids_limit=512", patch)
        self.assertIn("mem_limit=17179869184", patch)
        self.assertIn("nano_cpus=4000000000", patch)
        self.assertIn("read_only=True", patch)
        self.assertIn("user=\"65532:65532\"", patch)
        self.assertIn('labels={"alloy.swebench.gate": run_id}', patch)
        self.assertIn('host.get("Privileged") is not False', patch)
        self.assertIn('host.get("Devices") not in ([], None)', patch)
        self.assertIn('set(networks) - {"none"}', patch)
        self.assertIn("Evaluator workspace mount drifted", patch)
        self.assertNotIn('cap_add=["SYS_ADMIN"]', "\n".join(
            line[1:] for line in patch.splitlines() if line.startswith("+")
        ))

    def test_verify_checks_upstream_hash_before_no_fuzz_patch_and_installed_set(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        with (
            mock.patch.object(environment, "_installed_distributions", return_value=locked_distributions(LOCK_PATH)),
            mock.patch.object(environment, "_apply_verified_patch") as apply_patch,
            mock.patch.object(environment.runtime, "preflight"),
            mock.patch.object(environment.runtime, "pull_and_verify", return_value="sha256:" + "a" * 64),
        ):
            environment.verify()
        apply_patch.assert_called_once_with()

    def test_patch_application_checks_upstream_first_and_forbids_fuzz(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, VENV_PYTHON)
        pin = PROFILE.evaluator
        with (
            mock.patch.object(
                environment,
                "_sha256",
                side_effect=[
                    pin.upstream_run_evaluation_sha256,
                    pin.patch_sha256,
                    pin.patched_run_evaluation_sha256,
                ],
            ) as digest,
            mock.patch("benchmarks.swebench.evaluator.subprocess.run") as run,
        ):
            environment._apply_verified_patch()
        self.assertEqual(digest.call_args_list[0], mock.call(environment.source_path))
        command = run.call_args.args[0]
        self.assertIn("--fuzz=0", command)
        self.assertEqual(command[0], "/usr/bin/patch")

    def test_run_uses_local_json_one_instance_one_worker_no_pull_and_schema_v2(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.jsonl"
            dataset = root / "dataset.json"
            predictions.write_text("{}\n")
            dataset.write_text("[]\n")
            environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
            summary = root / "model.run-1.json"
            summary.write_text(json.dumps({"schema_version": 2, "resolved_ids": [PROFILE.instance_id]}))
            with (
                mock.patch.object(environment, "verify"),
                mock.patch.object(environment, "_run_evaluator", return_value=("stdout", "stderr", summary)) as run,
                mock.patch.object(environment, "_verify_and_teardown_container") as teardown,
            ):
                result = environment.run(predictions, dataset, "run-1")
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--dataset_name") + 1], str(dataset.resolve()))
        self.assertEqual(command[command.index("--instance_ids") + 1], PROFILE.instance_id)
        self.assertEqual(command[command.index("--max_workers") + 1], "1")
        self.assertIn("--no_pull", command)
        teardown.assert_called_once_with("run-1")
        self.assertEqual(result.summary["schema_version"], 2)


if __name__ == "__main__":
    unittest.main()
