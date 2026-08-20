import hashlib
import json
import re
import subprocess
import sys
import tempfile
import textwrap
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
        self.assertEqual(installed, locked_distributions(LOCK_PATH))

    def test_requirements_input_is_the_exact_closed_lock_set_including_pip(self):
        inputs = {}
        for line in (BENCH_ROOT / "requirements.in").read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            match = re.fullmatch(r"([a-z0-9][a-z0-9._-]*)==([^\s]+)", stripped)
            self.assertIsNotNone(match, stripped)
            assert match is not None
            inputs[match.group(1)] = match.group(2)
        self.assertIn("pip", inputs)
        self.assertEqual(inputs, locked_distributions(LOCK_PATH))

    def test_offline_lock_regeneration_cannot_resolve_different_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            regenerated = Path(directory) / "requirements.lock"
            subprocess.run(
                [
                    "uv", "pip", "compile",
                    "--offline",
                    "--python", str(VENV_PYTHON),
                    "--generate-hashes",
                    "--no-emit-index-url",
                    "--output-file", str(regenerated),
                    str(BENCH_ROOT / "requirements.in"),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(locked_distributions(regenerated), locked_distributions(LOCK_PATH))


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
            mock.patch.object(environment.runtime, "verify_local_image", return_value="sha256:" + "a" * 64),
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


class InstalledPatchedEvaluatorTests(unittest.TestCase):
    def test_installed_patched_create_path_enforces_exact_confinement_without_pull(self):
        source = BENCH_ROOT / ".venv" / "lib" / "python3.14" / "site-packages" / "swebench" / "harness" / "run_evaluation.py"
        self.assertEqual(
            hashlib.sha256(source.read_bytes()).hexdigest(),
            PROFILE.evaluator.patched_run_evaluation_sha256,
        )
        script = textwrap.dedent(
            f"""
            import json
            import os
            import types
            import docker
            import swebench.harness.run_evaluation as patched

            digest = {PROFILE.evaluator_image.manifest_digest!r}
            reference = {PROFILE.evaluator_image.reference!r}
            image_id = "sha256:" + "a" * 64
            run_id = "run-actual-patch"
            os.environ.update({{
                "SWEBENCH_EVALUATOR_IMAGE": reference,
                "SWEBENCH_EVALUATOR_IMAGE_DIGEST": digest,
                "SWEBENCH_EVALUATOR_IMAGE_ID": image_id,
                "SWEBENCH_SECCOMP_PATH": {str(REPO_ROOT / PROFILE.security_policy.seccomp_path)!r},
                "SWEBENCH_APPARMOR_NAME": {PROFILE.security_policy.apparmor_name!r},
            }})

            class Logger:
                log_file = "fake.log"
                def info(self, *_): pass
                def error(self, *_): pass

            class Image:
                id = image_id
                attrs = {{"RepoDigests": [reference], "Os": "linux", "Architecture": "amd64"}}
                def reload(self): pass

            class Images:
                pull_calls = 0
                def get(self, value):
                    assert value == reference
                    return Image()
                def pull(self, *_):
                    self.pull_calls += 1
                    raise AssertionError("pull forbidden")

            class Volume:
                attrs = {{"Labels": {{"alloy.swebench.gate": run_id}}, "Driver": "local", "Options": None, "Scope": "local"}}
                def reload(self): pass

            class Volumes:
                def get(self, _): raise docker.errors.NotFound("missing")
                def create(self, **kwargs):
                    self.kwargs = kwargs
                    return Volume()

            class Container:
                id = "container-id"
                attrs = {{
                    "Image": image_id,
                    "Config": {{"User": "65532:65532", "Labels": {{"alloy.swebench.gate": run_id}}}},
                    "HostConfig": {{
                        "Privileged": False, "CapDrop": ["ALL"],
                        "SecurityOpt": ["no-new-privileges:true", "seccomp=" + os.environ["SWEBENCH_SECCOMP_PATH"], "apparmor=alloy-swebench-gate"],
                        "ReadonlyRootfs": True, "Init": True, "PidsLimit": 512,
                        "Memory": 17179869184, "NanoCpus": 4000000000,
                        "PidMode": "", "IpcMode": "private", "UTSMode": "",
                        "NetworkMode": "none", "Devices": [],
                    }},
                    "NetworkSettings": {{"Networks": {{}}}},
                    "Mounts": [{{"Type": "volume", "Name": "alloy-eval-workspace-" + run_id, "Destination": "/testbed", "RW": True}}],
                }}
                def reload(self): pass

            class Containers:
                def get(self, _): raise docker.errors.NotFound("missing")
                def create(self, **kwargs):
                    self.kwargs = kwargs
                    return Container()

            client = types.SimpleNamespace(images=Images(), volumes=Volumes(), containers=Containers())
            spec = types.SimpleNamespace(instance_id={PROFILE.instance_id!r}, image="mutable:forbidden")
            container = patched.create_container(spec, client, run_id, Logger())
            assert container.id == "container-id"
            assert client.images.pull_calls == 0
            kwargs = client.containers.kwargs
            assert kwargs["image"] == reference
            assert kwargs["cap_drop"] == ["ALL"]
            assert kwargs["network_disabled"] is True
            assert kwargs["read_only"] is True
            assert kwargs["user"] == "65532:65532"
            print(json.dumps(kwargs, sort_keys=True))
            """
        )
        result = subprocess.run(
            [str(VENV_PYTHON), "-c", script],
            check=True,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        kwargs = json.loads(result.stdout)
        self.assertEqual(kwargs["image"], PROFILE.evaluator_image.reference)

    def test_installed_patch_rejects_verified_image_id_drift(self):
        script = textwrap.dedent(
            f"""
            import os
            import types
            import docker
            import swebench.harness.run_evaluation as patched
            os.environ.update({{
                "SWEBENCH_EVALUATOR_IMAGE": {PROFILE.evaluator_image.reference!r},
                "SWEBENCH_EVALUATOR_IMAGE_DIGEST": {PROFILE.evaluator_image.manifest_digest!r},
                "SWEBENCH_EVALUATOR_IMAGE_ID": "sha256:" + "b" * 64,
                "SWEBENCH_SECCOMP_PATH": {str(REPO_ROOT / PROFILE.security_policy.seccomp_path)!r},
                "SWEBENCH_APPARMOR_NAME": "alloy-swebench-gate",
            }})
            class Logger:
                log_file = "fake.log"
                def info(self, *_): pass
                def error(self, *_): pass
            image = types.SimpleNamespace(
                id="sha256:" + "a" * 64,
                attrs={{"RepoDigests": [{PROFILE.evaluator_image.reference!r}], "Os": "linux", "Architecture": "amd64"}},
                reload=lambda: None,
            )
            client = types.SimpleNamespace(images=types.SimpleNamespace(get=lambda _: image))
            spec = types.SimpleNamespace(instance_id={PROFILE.instance_id!r}, image="ignored")
            try:
                patched.create_container(spec, client, "run-id-drift", Logger())
            except Exception as error:
                assert "image ID" in str(error), error
            else:
                raise AssertionError("patched evaluator accepted image ID drift")
            """
        )
        result = subprocess.run(
            [str(VENV_PYTHON), "-c", script],
            check=False,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
