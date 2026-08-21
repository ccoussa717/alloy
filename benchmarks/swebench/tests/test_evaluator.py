import hashlib
import json
import re
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swebench.evaluator import (
    EvaluationCleanupError,
    EvaluationExecution,
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
    def test_failure_logs_are_bounded_binary_safe_and_do_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = root / "secret"
            secret.write_text("host-secret")
            scratch = root / "scratch"
            scratch.mkdir()
            (scratch / "binary.log").write_bytes(b"x" * 20_000 + b"\xfftail")
            (scratch / "escape.log").symlink_to(secret)

            captured = EvaluatorEnvironment._failure_logs(scratch)

        self.assertLessEqual(len(captured.encode()), 16_500)
        self.assertIn("tail", captured)
        self.assertNotIn("host-secret", captured)

    def test_evaluator_observation_waits_for_owned_container_and_records_exact_evidence(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        process = mock.Mock()
        process.poll.return_value = None
        expected = {"container_id": "observed", "inspection": {}}
        environment.runtime.inspect_owned_container = mock.Mock(
            side_effect=[None, expected]
        )
        environment._validate_evaluator_evidence = mock.Mock()

        with mock.patch("benchmarks.swebench.evaluator.time.sleep"):
            evidence = environment._await_evaluator_evidence(
                "run-1", process, time.monotonic() + 1
            )

        self.assertIs(evidence, expected)
        self.assertEqual(environment._last_evaluator_handle.container_id, "observed")
        environment._validate_evaluator_evidence.assert_called_once_with(
            expected, "run-1"
        )

    def test_evaluator_observation_rechecks_after_process_exit(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        process = mock.Mock(args=["evaluator"])
        process.poll.return_value = 0
        expected = {"container_id": "observed-after-exit", "inspection": {}}
        environment.runtime.inspect_owned_container = mock.Mock(
            side_effect=[None, expected]
        )
        environment._validate_evaluator_evidence = mock.Mock()

        evidence = environment._await_evaluator_evidence(
            "run-1", process, time.monotonic() + 1
        )

        self.assertIs(evidence, expected)
        self.assertEqual(
            environment.runtime.inspect_owned_container.call_count, 2
        )

    def test_evaluator_observation_preserves_early_process_failure_output(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        process = mock.Mock(args=["evaluator"])
        process.poll.return_value = 17
        process.communicate.return_value = ("harness output", "harness error")
        environment.runtime.inspect_owned_container = mock.Mock(return_value=None)

        with self.assertRaises(subprocess.CalledProcessError) as raised:
            environment._await_evaluator_evidence(
                "run-1", process, time.monotonic() + 1
            )

        self.assertEqual(raised.exception.returncode, 17)
        self.assertEqual(raised.exception.output, "harness output")
        self.assertEqual(raised.exception.stderr, "harness error")

    def test_observed_evaluator_evidence_is_exact_and_drift_is_rejected(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        environment._image_id = "sha256:" + "a" * 64
        run_id = "run-1"
        evidence = {
            "container_id": "evaluator-id",
            "daemon_identity": {"daemon_id": "daemon-id"},
            "inspection": {
                "Image": environment._image_id,
                "Config": {
                    "User": "65532:65532",
                    "Labels": {"alloy.swebench.gate": run_id},
                },
                "HostConfig": {
                    "CapDrop": ["ALL"],
                    "Privileged": False,
                    "ReadonlyRootfs": True,
                    "Init": True,
                    "NetworkMode": "none",
                    "PidsLimit": PROFILE.limits.pids,
                    "Memory": PROFILE.limits.memory_bytes,
                    "NanoCpus": PROFILE.limits.cpus * 1_000_000_000,
                    "SecurityOpt": [
                        "no-new-privileges",
                        "seccomp=" + (
                            REPO_ROOT / PROFILE.security_policy.seccomp_path
                        ).read_text(),
                        f"apparmor={PROFILE.security_policy.apparmor_name}",
                    ],
                },
                "NetworkSettings": {"Networks": {}},
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": f"alloy-eval-workspace-{run_id}",
                        "Destination": "/testbed",
                        "RW": True,
                    }
                ],
            },
        }

        environment._validate_evaluator_evidence(evidence, run_id)
        evidence["inspection"]["HostConfig"]["NetworkMode"] = "bridge"
        with self.assertRaisesRegex(RuntimeError, "inspection drifted"):
            environment._validate_evaluator_evidence(evidence, run_id)

    def test_trusted_teardown_removes_and_proves_workspace_volume_absent(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        run_id = "run-cleanup"
        handle = mock.Mock(container_id="evaluator-id")
        environment._last_evaluator_handle = handle
        environment.runtime.force_remove = mock.Mock()
        environment.runtime.assert_absent = mock.Mock()
        environment.runtime.remove_volume = mock.Mock()

        evidence = environment._verify_and_teardown_container(run_id)

        environment.runtime.force_remove.assert_called_once_with(handle)
        environment.runtime.assert_absent.assert_called_once_with(handle)
        environment.runtime.remove_volume.assert_called_once_with(
            f"alloy-eval-workspace-{run_id}", run_id
        )
        self.assertEqual(
            evidence,
            {
                "absent": True,
                "container_id": "evaluator-id",
                "daemon_identity": None,
                "workspace_volume": f"alloy-eval-workspace-{run_id}",
                "workspace_volume_absent": True,
            },
        )

    def test_workspace_volume_cleanup_runs_even_if_container_cleanup_fails(self):
        environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
        run_id = "run-dual-cleanup"
        environment.runtime.force_remove = mock.Mock(
            side_effect=RuntimeError("container cleanup failed")
        )
        environment.runtime.remove_volume = mock.Mock()

        with self.assertRaisesRegex(RuntimeError, "evaluator resource teardown failed"):
            environment._verify_and_teardown_container(run_id)

        environment.runtime.remove_volume.assert_called_once_with(
            f"alloy-eval-workspace-{run_id}", run_id
        )

    def test_patch_is_confinement_only_and_has_no_sys_admin_or_fuzz(self):
        patch = PATCH_PATH.read_text()
        self.assertIn('cap_drop=["ALL"]', patch)
        self.assertIn('network_mode="none"', patch)
        self.assertIn('cgroupns="private"', patch)
        self.assertIn("no-new-privileges", patch)
        self.assertIn("alloy-swebench-gate", patch)
        self.assertIn("pids_limit=512", patch)
        self.assertIn("mem_limit=17179869184", patch)
        self.assertIn("nano_cpus=4000000000", patch)
        self.assertIn("read_only=True", patch)
        self.assertIn("user=\"65532:65532\"", patch)
        self.assertIn('labels={"alloy.swebench.gate": run_id}', patch)
        self.assertIn('host.get("Privileged") is not False', patch)
        self.assertIn('host.get("CgroupnsMode") != "private"', patch)
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
            scratch = root / "scratch"
            scratch.mkdir()
            summary = scratch / "model.run-1.json"
            summary.write_text(json.dumps({"schema_version": 2, "resolved_ids": [PROFILE.instance_id]}))
            with (
                mock.patch.object(environment, "verify"),
                mock.patch.object(
                    environment,
                    "_run_evaluator",
                    return_value=EvaluationExecution(
                        "stdout",
                        "stderr",
                        scratch,
                        "run-1",
                        {"container_id": "evaluator-id", "inspection": {"Image": "image-id"}},
                    ),
                ) as run,
                mock.patch.object(
                    environment,
                    "_verify_and_teardown_container",
                    return_value={"container_id": "evaluator-id", "absent": True},
                ) as teardown,
            ):
                result = environment.run(predictions, dataset, "run-1")
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--dataset_name") + 1], str(dataset.resolve()))
        self.assertEqual(command[command.index("--instance_ids") + 1], PROFILE.instance_id)
        self.assertEqual(command[command.index("--max_workers") + 1], "1")
        self.assertIn("--no_pull", command)
        teardown.assert_called_once_with("run-1")
        self.assertEqual(result.summary["schema_version"], 2)
        self.assertEqual(result.container_evidence["container_id"], "evaluator-id")
        self.assertTrue(result.teardown_evidence["absent"])

    def test_primary_evaluator_error_and_teardown_error_are_both_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.jsonl"
            dataset = root / "dataset.json"
            predictions.write_text("{}\n")
            dataset.write_text("[]\n")
            environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, Path(sys.executable))
            primary = subprocess.TimeoutExpired(["evaluator"], 2400)
            cleanup = RuntimeError("evaluator teardown uncertain")
            with (
                mock.patch.object(environment, "verify"),
                mock.patch.object(environment, "_run_evaluator", side_effect=primary),
                mock.patch.object(
                    environment,
                    "_verify_and_teardown_container",
                    side_effect=cleanup,
                ),
                self.assertRaises(EvaluationCleanupError) as raised,
            ):
                environment.run(predictions, dataset, "run-1")

        self.assertIs(raised.exception.original_error, primary)
        self.assertIs(raised.exception.cleanup_error, cleanup)
        self.assertIs(raised.exception.__cause__, primary)

    def test_run_cleans_workspace_volume_after_timeout_crash_and_interruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.jsonl"
            dataset = root / "dataset.json"
            predictions.write_text("{}\n")
            dataset.write_text("[]\n")
            failures = (
                subprocess.TimeoutExpired(["evaluator"], 2400),
                subprocess.CalledProcessError(17, ["evaluator"]),
                KeyboardInterrupt(),
            )
            for failure in failures:
                with self.subTest(failure=type(failure).__name__):
                    environment = EvaluatorEnvironment(
                        PROFILE, REPO_ROOT, Path(sys.executable)
                    )
                    environment.runtime.force_remove = mock.Mock()
                    environment.runtime.assert_absent = mock.Mock()
                    environment.runtime.remove_volume = mock.Mock()
                    with (
                        mock.patch.object(environment, "verify"),
                        mock.patch.object(
                            environment, "_run_evaluator", side_effect=failure
                        ),
                        self.assertRaises(type(failure)),
                    ):
                        environment.run(predictions, dataset, "run-interrupted")
                    environment.runtime.remove_volume.assert_called_once_with(
                        "alloy-eval-workspace-run-interrupted", "run-interrupted"
                    )

    def test_summary_is_not_located_read_or_parsed_before_verified_teardown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.jsonl"
            dataset = root / "dataset.json"
            predictions.write_text("{}\n")
            dataset.write_text("[]\n")
            environment = EvaluatorEnvironment(PROFILE, REPO_ROOT, VENV_PYTHON)
            environment._image_id = "sha256:" + "a" * 64
            events = []
            original_glob = Path.glob
            original_read_text = Path.read_text
            original_json_loads = json.loads
            executions = []
            commands = []

            class FakeProcess:
                pid = 12345
                returncode = 0

                def communicate(self, timeout=None):
                    return "stdout", "stderr"

                def poll(self):
                    return self.returncode

            def run_evaluator_process(command, **kwargs):
                commands.append(command)
                scratch = kwargs["cwd"]
                (scratch / "model.run-order.json").write_text(
                    json.dumps({"schema_version": 2, "resolved_ids": [PROFILE.instance_id]})
                )
                return FakeProcess()

            def record_glob(path, pattern):
                if pattern == "*.run-order.json":
                    events.append("locate-summary")
                return original_glob(path, pattern)

            def record_read_text(path, *args, **kwargs):
                if path.name == "model.run-order.json":
                    events.append("read-summary")
                return original_read_text(path, *args, **kwargs)

            def record_json_loads(value, *args, **kwargs):
                events.append("parse-summary")
                return original_json_loads(value, *args, **kwargs)

            run_evaluator = environment._run_evaluator

            def record_execution(command):
                execution = run_evaluator(command)
                executions.append(execution)
                return execution

            def record_inspection(_run_id, _process, _deadline):
                events.append("inspect-container")
                return {"container_id": "evaluator-id", "inspection": {}}

            def record_verified_teardown(_run_id):
                events.extend(["force-remove", "absence-verified"])
                return {"container_id": "evaluator-id", "absent": True}

            with (
                mock.patch.object(environment, "verify"),
                mock.patch(
                    "benchmarks.swebench.evaluator.subprocess.Popen",
                    side_effect=run_evaluator_process,
                ),
                mock.patch.object(
                    environment,
                    "_await_evaluator_evidence",
                    side_effect=record_inspection,
                ),
                mock.patch.object(environment, "_run_evaluator", side_effect=record_execution),
                mock.patch.object(
                    environment,
                    "_verify_and_teardown_container",
                    side_effect=record_verified_teardown,
                ),
                mock.patch.object(Path, "glob", record_glob),
                mock.patch.object(Path, "read_text", record_read_text),
                mock.patch("benchmarks.swebench.evaluator.json.loads", side_effect=record_json_loads),
            ):
                result = environment.run(predictions, dataset, "run-order")

        self.assertEqual(
            events,
            [
                "inspect-container",
                "force-remove",
                "absence-verified",
                "locate-summary",
                "read-summary",
                "parse-summary",
            ],
        )
        self.assertEqual(
            commands[0][:3],
            [str(VENV_PYTHON), "-m", "swebench.harness.run_evaluation"],
        )
        self.assertEqual(len(executions), 1)
        self.assertIsInstance(executions[0], EvaluationExecution)
        self.assertFalse(executions[0].scratch.exists())
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
            patched.cleanup_container = lambda *_: None

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
                def remove(self, **_): pass

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
                        "SecurityOpt": ["no-new-privileges:true", "seccomp=" + open(os.environ["SWEBENCH_SECCOMP_PATH"]).read(), "apparmor=alloy-swebench-gate"],
                        "ReadonlyRootfs": True, "Init": True, "PidsLimit": 512,
                        "Memory": 17179869184, "NanoCpus": 4000000000,
                        "CgroupnsMode": "private",
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
            assert kwargs["network_mode"] == "none"
            assert kwargs["cgroupns"] == "private"
            assert kwargs["read_only"] is True
            assert kwargs["user"] == "65532:65532"
            for value in ("host", "", None):
                if value is None:
                    Container.attrs["HostConfig"].pop("CgroupnsMode", None)
                else:
                    Container.attrs["HostConfig"]["CgroupnsMode"] = value
                try:
                    patched.create_container(spec, client, run_id, Logger())
                except Exception as error:
                    assert "cgroup namespace" in str(error), error
                else:
                    raise AssertionError("patched evaluator accepted non-private cgroup namespace")
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
