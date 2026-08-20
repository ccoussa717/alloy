import copy
import json
import os
import socket
import stat
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import benchmarks.swebench.containers as containers
from benchmarks.swebench.containers import (
    ContainerHandle,
    ContainerSpec,
    DockerRuntime,
    MountSpec,
)
from benchmarks.swebench.profile import ImagePin, load_profile


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
APPARMOR_PATH = PROFILE_PATH.parent / "policies" / "alloy-swebench-gate.apparmor"


class ScriptedRunner:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, arguments, **kwargs):
        self.calls.append((arguments, kwargs))
        if not self.results:
            raise AssertionError(f"unexpected command: {arguments}")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        if result.returncode and kwargs.get("check"):
            raise subprocess.CalledProcessError(
                result.returncode, arguments, output=result.stdout, stderr=result.stderr
            )
        return result


def completed(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)


def absent():
    return completed(returncode=1, stderr="Error: No such object: missing\n")


class DockerRuntimeTests(unittest.TestCase):
    def setUp(self):
        euid_patch = mock.patch(
            "benchmarks.swebench.containers.os.geteuid", return_value=0
        )
        self.euid = euid_patch.start()
        self.addCleanup(euid_patch.stop)
        self.profile = load_profile(PROFILE_PATH, REPO_ROOT)
        self.image = self.profile.agent_image
        self.image_id = "sha256:" + "a" * 64
        self.mount = MountSpec(
            "alloy-checkout-run-123", "/workspace", read_only=False, kind="volume"
        )
        self.spec = ContainerSpec(
            name="alloy-agent-run-123",
            run_id="run-123",
            image=self.image,
            image_id=self.image_id,
            command=("node", "agent.js"),
            mounts=(self.mount,),
        )

    def runtime(self, runner):
        return DockerRuntime(self.profile, REPO_ROOT, runner=runner)

    def docker_info(self):
        return {
            "CgroupVersion": "2",
            "SecurityOptions": ["name=apparmor", "name=seccomp"],
            "OSType": "linux",
            "Architecture": "x86_64",
            "ID": "daemon-id",
            "Name": "local-daemon",
            "DockerRootDir": "/var/lib/docker",
            "ServerVersion": "29.6.2",
        }

    def successful_preflight(self):
        return (
            completed(json.dumps(self.docker_info())),
            completed(),
            completed(json.dumps({"profiles": {"alloy-swebench-gate": "enforce"}})),
        )

    def preflighted_runtime(self, runner):
        runtime = self.runtime(runner)
        runtime.preflight()
        return runtime

    def inspection(self):
        return {
            "Id": "container-id",
            "Image": self.image_id,
            "Config": {
                "User": "65532:65532",
                "Labels": {"alloy.swebench.gate": "run-123"},
            },
            "HostConfig": {
                "Privileged": False,
                "CapDrop": ["ALL"],
                "SecurityOpt": [
                    "no-new-privileges",
                    f"seccomp={REPO_ROOT / self.profile.security_policy.seccomp_path}",
                    "apparmor=alloy-swebench-gate",
                ],
                "ReadonlyRootfs": True,
                "Init": True,
                "PidsLimit": 512,
                "Memory": 17179869184,
                "NanoCpus": 4_000_000_000,
                "PidMode": "",
                "IpcMode": "private",
                "UTSMode": "",
                "NetworkMode": "none",
                "Devices": [],
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "alloy-checkout-run-123",
                    "Destination": "/workspace",
                    "RW": True,
                }
            ],
            "NetworkSettings": {"Networks": {}},
        }

    def owned_volume(self, run_id="run-123"):
        return {
            "Name": "alloy-checkout-run-123",
            "Labels": {"alloy.swebench.gate": run_id},
            "Driver": "local",
            "Options": None,
            "Scope": "local",
        }

    def test_create_uses_exact_confinement_argv_and_inspects_before_start(self):
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(self.docker_info())),
            completed(),
        )

        handle = self.preflighted_runtime(runner).create(self.spec)

        seccomp = REPO_ROOT / self.profile.security_policy.seccomp_path
        self.assertEqual(
            runner.calls[5][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "create", "--name", "alloy-agent-run-123",
                "--label", "alloy.swebench.gate=run-123",
                "--platform", "linux/amd64",
                "--user", "65532:65532",
                "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges",
                "--security-opt", f"seccomp={seccomp}",
                "--security-opt", "apparmor=alloy-swebench-gate",
                "--read-only", "--init",
                "--pids-limit", "512",
                "--memory", "17179869184",
                "--cpus", "4",
                "--network", "none",
                "--mount", "type=volume,src=alloy-checkout-run-123,dst=/workspace",
                self.image.reference,
                "node", "agent.js",
            ],
        )
        self.assertEqual(
            runner.calls[3][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "volume", "inspect", "alloy-checkout-run-123",
            ],
        )
        identity_command = [
            "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
            "info", "--format", "{{json .}}",
        ]
        self.assertEqual(runner.calls[4][0], identity_command)
        self.assertEqual(runner.calls[6][0], identity_command)
        self.assertEqual(
            runner.calls[7][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "inspect", "container-id",
            ],
        )
        self.assertEqual(runner.calls[8][0], identity_command)
        self.assertEqual(
            runner.calls[9][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "start", "container-id",
            ],
        )
        self.assertEqual(handle, ContainerHandle("alloy-agent-run-123", "container-id", "run-123"))

    def test_create_rejects_daemon_identity_drift_after_preflight(self):
        changed = {**self.docker_info(), "ID": "different-daemon"}
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(changed)),
        )
        runtime = self.preflighted_runtime(runner)

        with self.assertRaisesRegex(RuntimeError, "daemon identity drift"):
            runtime.create(self.spec)

        self.assertEqual(len(runner.calls), 5)

    def test_start_rejects_daemon_identity_drift_after_create(self):
        changed = {**self.docker_info(), "ServerVersion": "99.0.0"}
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(changed)),
            completed(json.dumps(changed)),
        )
        runtime = self.preflighted_runtime(runner)

        with self.assertRaisesRegex(
            containers.CleanupUncertainError, self.spec.name
        ) as raised:
            runtime.create(self.spec)

        self.assertIsInstance(
            raised.exception.original_error, containers.DaemonIdentityDriftError
        )
        self.assertEqual(len(runner.calls), 10)
        self.assertFalse(any("start" in arguments for arguments, _ in runner.calls))

    def test_drift_after_create_before_inspection_surfaces_cleanup_uncertainty(self):
        changed = {**self.docker_info(), "ID": "replacement-daemon"}
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(changed)),
            completed(json.dumps(changed)),
        )
        runtime = self.preflighted_runtime(runner)

        with self.assertRaisesRegex(
            containers.CleanupUncertainError, self.spec.name
        ) as raised:
            runtime.create(self.spec)

        self.assertIs(raised.exception.__cause__, raised.exception.original_error)
        self.assertIsInstance(
            raised.exception.original_error, containers.DaemonIdentityDriftError
        )
        self.assertIsInstance(
            raised.exception.cleanup_error, containers.DaemonIdentityDriftError
        )
        self.assertEqual(len(runner.calls), 8)
        self.assertTrue(all(arguments[3] == "info" for arguments, _ in runner.calls[6:]))

    def test_public_teardown_rejects_drift_after_successful_start(self):
        changed = {**self.docker_info(), "DockerRootDir": "/replacement"}
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(self.docker_info())),
            completed(),
            completed(json.dumps(changed)),
        )
        runtime = self.preflighted_runtime(runner)
        handle = runtime.create(self.spec)

        with self.assertRaisesRegex(
            containers.DaemonIdentityDriftError, self.spec.name
        ):
            runtime.force_remove(handle)

        self.assertEqual(runner.calls[-1][0][3], "info")

    def test_rejects_unsafe_or_mutable_container_specs_before_docker(self):
        mutable = ImagePin("node:latest", "sha256:" + "b" * 64, "linux/amd64")
        cases = (
            ({"image": mutable}, "digest-qualified"),
            ({"privileged": True}, "privileged"),
            ({"pid_mode": "host"}, "host PID"),
            ({"ipc_mode": "host"}, "host IPC"),
            ({"uts_mode": "host"}, "host UTS"),
            ({"network_mode": "host"}, "host network"),
            ({"devices": ("/dev/kvm",)}, "devices"),
            (
                {
                    "mounts": (
                        MountSpec(
                            Path("/var/run/docker.sock"), "/docker.sock", True, kind="bind"
                        ),
                    )
                },
                "Docker socket",
            ),
            (
                {
                    "mounts": (
                        MountSpec(APPARMOR_PATH, "/policy", False, kind="bind"),
                    )
                },
                "read-only",
            ),
        )
        for changes, message in cases:
            values = {**self.spec.__dict__, **changes}
            spec = ContainerSpec(**values)
            runner = ScriptedRunner(*self.successful_preflight())
            runtime = self.preflighted_runtime(runner)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                runtime.create(spec)
            self.assertEqual(len(runner.calls), 3)

    def test_preflight_reloads_enforcing_profile_and_binds_report_to_policy(self):
        runner = ScriptedRunner(*self.successful_preflight())
        report = self.runtime(runner).preflight()

        self.assertEqual(report.cgroup_version, "2")
        self.assertTrue(report.apparmor)
        self.assertEqual(report.os_type, "linux")
        self.assertEqual(report.architecture, "x86_64")
        self.assertEqual(report.apparmor_name, "alloy-swebench-gate")
        self.assertEqual(report.seccomp_sha256, self.profile.security_policy.seccomp_sha256)
        self.assertEqual(report.apparmor_sha256, self.profile.security_policy.apparmor_sha256)
        self.assertRegex(report.profile_fingerprint, r"^[0-9a-f]{64}$")
        self.assertEqual(report.daemon_identity.endpoint, "unix:///var/run/docker.sock")
        self.assertEqual(report.daemon_identity.daemon_id, "daemon-id")
        self.assertEqual(report.daemon_identity.name, "local-daemon")
        self.assertEqual(report.daemon_identity.root_dir, "/var/lib/docker")
        self.assertEqual(report.daemon_identity.server_version, "29.6.2")
        self.assertEqual(
            runner.calls[0][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "info", "--format", "{{json .}}",
            ],
        )
        self.assertEqual(
            runner.calls[1][0],
            ["/usr/sbin/apparmor_parser", "-r", str(APPARMOR_PATH)],
        )
        self.assertEqual(runner.calls[2][0], ["/usr/sbin/aa-status", "--json"])
        for _, kwargs in runner.calls:
            self.assertEqual(
                kwargs["env"],
                {
                    "HOME": "/root",
                    "LANG": "C.UTF-8",
                    "LC_ALL": "C.UTF-8",
                    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                },
            )

        amd64_info = {**self.docker_info(), "Architecture": "amd64"}
        amd64_runner = ScriptedRunner(
            completed(json.dumps(amd64_info)), completed(),
            completed(json.dumps({"profiles": {"alloy-swebench-gate": "enforce"}})),
        )
        self.assertEqual(self.runtime(amd64_runner).preflight().architecture, "amd64")

    def test_preflight_rejects_docker_environment_context_overrides(self):
        for variable, value in (
            ("DOCKER_HOST", "tcp://attacker.invalid:2375"),
            ("DOCKER_CONTEXT", "remote-production"),
        ):
            runner = ScriptedRunner()
            with mock.patch.dict(os.environ, {variable: value}, clear=False):
                with self.subTest(variable=variable), self.assertRaisesRegex(
                    RuntimeError, variable
                ):
                    self.runtime(runner).preflight()
            self.assertEqual(runner.calls, [])

    def test_preflight_rejects_noncanonical_nonroot_or_nonsocket_endpoint(self):
        cases = (
            (stat.S_IFREG | 0o660, 0, "/run/docker.sock", "Unix socket"),
            (stat.S_IFSOCK | 0o660, 1000, "/run/docker.sock", "root-owned"),
            (stat.S_IFSOCK | 0o660, 0, "/tmp/remote.sock", "canonical"),
        )
        for mode, uid, canonical, message in cases:
            metadata = types.SimpleNamespace(st_mode=mode, st_uid=uid)
            runner = ScriptedRunner()
            runtime = self.runtime(runner)
            with (
                mock.patch("benchmarks.swebench.containers.os.lstat", return_value=metadata),
                mock.patch(
                    "benchmarks.swebench.containers.os.path.realpath", return_value=canonical
                ),
            ):
                with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                    runtime.preflight()
                self.assertEqual(runner.calls, [])

    def test_preflight_ignores_malicious_path_shims(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "called"
            for name in ("docker", "apparmor_parser", "aa-status"):
                shim = Path(directory) / name
                shim.write_text("#!/bin/sh\ntouch " + str(marker) + "\nexit 99\n")
                shim.chmod(0o755)
            runner = ScriptedRunner(*self.successful_preflight())
            with mock.patch.dict(os.environ, {"PATH": directory}, clear=False):
                self.runtime(runner).preflight()
            self.assertFalse(marker.exists())
            self.assertTrue(all(call[0][0].startswith("/usr/") for call in runner.calls))

    def test_preflight_requires_root_before_any_external_command(self):
        runner = ScriptedRunner()
        self.euid.return_value = 1000
        runtime = DockerRuntime(self.profile, REPO_ROOT, runner=runner)
        with self.assertRaisesRegex(RuntimeError, "root"):
            runtime.preflight()
        self.assertEqual(runner.calls, [])

    def test_preflight_rejects_host_feature_platform_and_profile_failures(self):
        cases = (
            ({**self.docker_info(), "CgroupVersion": "1"}, "cgroup v2"),
            ({**self.docker_info(), "SecurityOptions": ["name=seccomp"]}, "AppArmor"),
            (
                {
                    **self.docker_info(),
                    "SecurityOptions": ["name=noapparmor", "name=seccomp-disabled"],
                },
                "AppArmor",
            ),
            ({**self.docker_info(), "OSType": "windows"}, "Linux Docker daemon"),
            ({**self.docker_info(), "Architecture": "arm64"}, "amd64 Docker daemon"),
        )
        for info, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                self.runtime(ScriptedRunner(completed(json.dumps(info)))).preflight()

        statuses = (
            ({"profiles": {}}, "not loaded"),
            ({"profiles": {"alloy-swebench-gate": "complain"}}, "enforce mode"),
        )
        for status, message in statuses:
            runner = ScriptedRunner(
                completed(json.dumps(self.docker_info())), completed(), completed(json.dumps(status))
            )
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                self.runtime(runner).preflight()

    def test_create_refuses_without_successful_same_runtime_preflight(self):
        runtime = self.runtime(ScriptedRunner())
        with self.assertRaisesRegex(RuntimeError, "official preflight"):
            runtime.create(self.spec)

    def test_create_requires_named_volume_with_matching_ownership_label(self):
        for metadata, message in (
            ({"Name": "alloy-checkout-run-123", "Labels": {}}, "ownership label"),
            (self.owned_volume("other-run"), "ownership label"),
            ({**self.owned_volume(), "Driver": "nfs"}, "plain local volume"),
            (
                {
                    **self.owned_volume(),
                    "Options": {"type": "none", "device": "/var/run", "o": "bind"},
                },
                "plain local volume",
            ),
            ({**self.owned_volume(), "Scope": "global"}, "plain local volume"),
        ):
            runner = ScriptedRunner(
                *self.successful_preflight(), completed(json.dumps([metadata]))
            )
            runtime = self.preflighted_runtime(runner)
            with self.subTest(metadata=metadata), self.assertRaisesRegex(RuntimeError, message):
                runtime.create(self.spec)
            self.assertEqual(len(runner.calls), 4)

    def test_preflight_reload_and_status_failures_are_fatal(self):
        failures = (
            (
                ScriptedRunner(
                    completed(json.dumps(self.docker_info())),
                    subprocess.CalledProcessError(1, ["apparmor_parser"], stderr="denied"),
                ),
                subprocess.CalledProcessError,
            ),
            (
                ScriptedRunner(
                    completed(json.dumps(self.docker_info())),
                    completed(),
                    subprocess.CalledProcessError(1, ["aa-status"], stderr="denied"),
                ),
                subprocess.CalledProcessError,
            ),
        )
        for runner, error in failures:
            with self.subTest(command=len(runner.results)), self.assertRaises(error):
                self.runtime(runner).preflight()

    def test_create_rechecks_policy_bytes_after_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Path(directory)
            for relative in (
                self.profile.security_policy.seccomp_path,
                self.profile.security_policy.apparmor_path,
            ):
                target = authority / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((REPO_ROOT / relative).read_bytes())
            runner = ScriptedRunner(*self.successful_preflight())
            runtime = DockerRuntime(self.profile, authority, runner=runner)
            runtime.preflight()
            (authority / self.profile.security_policy.apparmor_path).write_text("tampered")
            with self.assertRaisesRegex(RuntimeError, "AppArmor policy digest"):
                runtime.create(self.spec)

    def test_preflight_rejects_policy_digest_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            authority = Path(directory)
            for relative in (
                self.profile.security_policy.seccomp_path,
                self.profile.security_policy.apparmor_path,
            ):
                target = authority / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((REPO_ROOT / relative).read_bytes())
            (authority / self.profile.security_policy.seccomp_path).write_text("tampered")
            runtime = DockerRuntime(self.profile, authority, runner=ScriptedRunner())
            with self.assertRaisesRegex(RuntimeError, "seccomp policy digest"):
                runtime.preflight()

    def test_pull_verifies_exact_repo_digest_platform_and_returns_image_id(self):
        metadata = {
            "Id": self.image_id,
            "Architecture": "amd64",
            "Os": "linux",
            "RepoDigests": [f"node@{self.image.manifest_digest}"],
        }
        runner = ScriptedRunner(completed(), completed(json.dumps([metadata])))

        image_id = self.runtime(runner).pull_and_verify(self.image)

        self.assertEqual(image_id, self.image_id)
        self.assertEqual(
            runner.calls[0][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "pull", "--platform", "linux/amd64", self.image.reference,
            ],
        )
        self.assertEqual(
            runner.calls[1][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "image", "inspect", self.image.reference,
            ],
        )

        for change, message in (
            ({"Architecture": "arm64"}, "linux/amd64"),
            ({"RepoDigests": ["node@sha256:" + "f" * 64]}, "manifest digest"),
            ({"Id": "not-a-digest"}, "image ID"),
        ):
            bad = {**metadata, **change}
            runtime = self.runtime(ScriptedRunner(completed(), completed(json.dumps([bad]))))
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                runtime.pull_and_verify(self.image)

    def test_verify_local_image_never_pulls_and_returns_exact_image_id(self):
        metadata = {
            "Id": self.image_id,
            "Architecture": "amd64",
            "Os": "linux",
            "RepoDigests": [f"node@{self.image.manifest_digest}"],
        }
        runner = ScriptedRunner(completed(json.dumps([metadata])))

        image_id = self.runtime(runner).verify_local_image(self.image)

        self.assertEqual(image_id, self.image_id)
        self.assertEqual(
            runner.calls[0][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "image", "inspect", self.image.reference,
            ],
        )
        self.assertEqual(len(runner.calls), 1)

    def test_inspection_rejects_every_security_drift(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        changes = (
            (("Config", "User"), "0:0", "numeric non-root user"),
            (("Config", "Labels"), {}, "ownership label"),
            (("HostConfig", "Privileged"), True, "privileged"),
            (("HostConfig", "CapDrop"), [], "capability drop"),
            (("HostConfig", "SecurityOpt"), [], "security options"),
            (("HostConfig", "ReadonlyRootfs"), False, "read-only root"),
            (("HostConfig", "Init"), False, "init"),
            (("HostConfig", "PidsLimit"), 513, "PID limit"),
            (("HostConfig", "Memory"), 1, "memory limit"),
            (("HostConfig", "NanoCpus"), 1, "CPU limit"),
            (("HostConfig", "PidMode"), "host", "PID namespace"),
            (("HostConfig", "IpcMode"), "host", "IPC namespace"),
            (("HostConfig", "UTSMode"), "host", "UTS namespace"),
            (("HostConfig", "NetworkMode"), "host", "network namespace"),
            (("HostConfig", "Devices"), [{"PathOnHost": "/dev/kvm"}], "devices"),
            (("Image",), "sha256:" + "f" * 64, "image ID"),
            (("NetworkSettings", "Networks"), {"bridge": {}}, "network membership"),
            (("Mounts",), [], "mounts"),
        )
        for path, value, message in changes:
            inspected = copy.deepcopy(self.inspection())
            target = inspected
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            runner = ScriptedRunner(completed(json.dumps([inspected])))
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                self.runtime(runner).inspect_security(handle, self.spec)

    def test_inspection_rejects_duplicate_conflicting_or_extra_security_options(self):
        expected = self.inspection()["HostConfig"]["SecurityOpt"]
        cases = (
            ([*expected, expected[0]], "security options"),
            ([*expected, "seccomp=unconfined"], "security options"),
            ([*expected, "apparmor=unconfined"], "security options"),
            ([expected[1], expected[2], "no-new-privileges:false"], "security options"),
            ([expected[0], expected[1], "apparmor=other-profile"], "security options"),
            ([*expected, "label=disable"], "security options"),
        )
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        for options, message in cases:
            inspected = self.inspection()
            inspected["HostConfig"]["SecurityOpt"] = options
            runner = ScriptedRunner(completed(json.dumps([inspected])))
            with self.subTest(options=options), self.assertRaisesRegex(RuntimeError, message):
                self.runtime(runner).inspect_security(handle, self.spec)

    def test_create_force_removes_container_when_inspection_fails(self):
        inspected = self.inspection()
        inspected["HostConfig"]["Privileged"] = True
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([inspected])),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(self.docker_info())),
            completed(),
            completed(json.dumps(self.docker_info())),
            absent(),
        )

        with self.assertRaisesRegex(RuntimeError, "privileged"):
            self.preflighted_runtime(runner).create(self.spec)

        self.assertEqual(
            runner.calls[9][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "inspect", "alloy-agent-run-123",
            ],
        )
        self.assertEqual(
            runner.calls[11][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "rm", "--force", "alloy-agent-run-123",
            ],
        )
        self.assertEqual(
            runner.calls[13][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "inspect", "alloy-agent-run-123",
            ],
        )

    def test_create_surfaces_cleanup_uncertainty_over_inspection_failure(self):
        inspected = self.inspection()
        inspected["HostConfig"]["Privileged"] = True
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps([self.owned_volume()])),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([inspected])),
            subprocess.CalledProcessError(1, ["docker", "info"], stderr="unavailable"),
        )

        with self.assertRaisesRegex(
            containers.CleanupUncertainError, self.spec.name
        ) as raised:
            self.preflighted_runtime(runner).create(self.spec)

        self.assertRegex(str(raised.exception.original_error), "privileged")
        self.assertIs(raised.exception.__cause__, raised.exception.original_error)
        self.assertIsInstance(
            raised.exception.cleanup_error, containers.DaemonIdentityDriftError
        )
        self.assertEqual(runner.calls[-1][0][3], "info")

    def test_force_remove_checks_label_and_asserts_absence(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(self.docker_info())),
            completed(),
            completed(json.dumps(self.docker_info())),
            absent(),
        )
        runtime = self.preflighted_runtime(runner)
        runtime.force_remove(handle)
        self.assertEqual(
            runner.calls[6][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "rm", "--force", self.spec.name,
            ],
        )

        reused = self.inspection()
        reused["Config"]["Labels"]["alloy.swebench.gate"] = "other-run"
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([reused])),
        )
        with self.assertRaisesRegex(RuntimeError, "different ownership label"):
            self.preflighted_runtime(runner).force_remove(handle)
        self.assertEqual(len(runner.calls), 5)

    def test_public_teardown_refuses_daemon_drift_without_inspect_or_remove(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        changed = {**self.docker_info(), "Name": "replacement-daemon"}
        for method_name in ("force_remove", "assert_absent"):
            runner = ScriptedRunner(
                *self.successful_preflight(), completed(json.dumps(changed))
            )
            runtime = self.preflighted_runtime(runner)
            with self.subTest(method=method_name), self.assertRaisesRegex(
                containers.DaemonIdentityDriftError, self.spec.name
            ):
                getattr(runtime, method_name)(handle)
            self.assertEqual(len(runner.calls), 4)
            self.assertEqual(runner.calls[-1][0][3], "info")

    def test_public_teardown_fails_closed_when_daemon_identity_cannot_be_queried(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        for method_name in ("force_remove", "assert_absent"):
            runner = ScriptedRunner(
                *self.successful_preflight(),
                subprocess.CalledProcessError(1, ["docker", "info"], stderr="unavailable"),
            )
            runtime = self.preflighted_runtime(runner)
            with self.subTest(method=method_name), self.assertRaisesRegex(
                containers.DaemonIdentityDriftError, "cannot prove"
            ):
                getattr(runtime, method_name)(handle)
            self.assertEqual(len(runner.calls), 4)

    def test_force_remove_rechecks_identity_after_inspect_before_remove(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        changed = {**self.docker_info(), "ID": "replacement-daemon"}
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([self.inspection()])),
            completed(json.dumps(changed)),
        )
        runtime = self.preflighted_runtime(runner)

        with self.assertRaisesRegex(
            containers.DaemonIdentityDriftError, self.spec.name
        ):
            runtime.force_remove(handle)

        self.assertEqual(len(runner.calls), 6)
        self.assertEqual(runner.calls[-1][0][3], "info")

    def test_assert_absent_fails_closed_when_docker_inspection_fails(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps(self.docker_info())),
            completed(returncode=1, stderr="daemon unavailable\n"),
        )
        with self.assertRaisesRegex(RuntimeError, "could not prove container absence"):
            self.preflighted_runtime(runner).assert_absent(handle)

    def test_bind_mounts_are_read_only_regular_authority_files_only(self):
        invalid = (
            (Path("/var/run"), "Docker socket"),
            (Path("/run"), "Docker socket"),
            (Path("/run/user/1000/docker.sock"), "Docker socket"),
            (Path("/home/test/.docker/run/docker.sock"), "Docker socket"),
            (APPARMOR_PATH.parent, "regular authority file"),
        )
        for source, message in invalid:
            spec = ContainerSpec(
                **{
                    **self.spec.__dict__,
                    "mounts": (MountSpec(source, "/workspace/source", True, kind="bind"),),
                }
            )
            runner = ScriptedRunner(*self.successful_preflight())
            runtime = self.runtime(runner)
            runtime.preflight()
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, message):
                runtime.create(spec)
            self.assertEqual(len(runner.calls), 3)

    def test_read_only_regular_authority_file_bind_is_accepted_and_inspected(self):
        mount = MountSpec(APPARMOR_PATH, "/policy", True, kind="bind")
        spec = ContainerSpec(**{**self.spec.__dict__, "mounts": (mount,)})
        inspected = self.inspection()
        inspected["Mounts"] = [
            {
                "Type": "bind",
                "Source": str(APPARMOR_PATH),
                "Destination": "/policy",
                "RW": False,
            }
        ]
        runner = ScriptedRunner(
            *self.successful_preflight(),
            completed(json.dumps(self.docker_info())),
            completed("container-id\n"),
            completed(json.dumps(self.docker_info())),
            completed(json.dumps([inspected])),
            completed(json.dumps(self.docker_info())),
            completed(),
        )

        self.preflighted_runtime(runner).create(spec)

        self.assertIn(
            "type=bind,src=" + str(APPARMOR_PATH) + ",dst=/policy,readonly",
            runner.calls[4][0],
        )

    def test_bind_mount_rejects_symlinks_sockets_and_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            regular = root / "regular"
            regular.touch()
            alias = root / "innocent"
            alias.symlink_to(regular)
            unix_socket = socket.socket(socket.AF_UNIX)
            socket_path = root / "service.sock"
            unix_socket.bind(str(socket_path))
            try:
                for source, message in (
                    (alias, "symlink"),
                    (socket_path, "regular authority file"),
                    (Path("/dev/null"), "regular authority file"),
                ):
                    spec = ContainerSpec(
                        **{
                            **self.spec.__dict__,
                            "mounts": (
                                MountSpec(source, "/workspace/source", True, kind="bind"),
                            ),
                        }
                    )
                    runner = ScriptedRunner(*self.successful_preflight())
                    runtime = self.runtime(runner)
                    runtime.preflight()
                    with self.subTest(source=source), self.assertRaisesRegex(ValueError, message):
                        runtime.create(spec)
            finally:
                unix_socket.close()

    def test_wait_returns_exit_code(self):
        runner = ScriptedRunner(completed("17\n"))
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        self.assertEqual(self.runtime(runner).wait(handle, timeout=9), 17)
        self.assertEqual(
            runner.calls[0][0],
            [
                "/usr/bin/docker", "--host", "unix:///var/run/docker.sock",
                "wait", "container-id",
            ],
        )
        self.assertEqual(runner.calls[0][1]["timeout"], 9)

    def test_apparmor_denies_sensitive_proc_sys_and_external_signals(self):
        policy = APPARMOR_PATH.read_text()
        for rule in (
            "deny /proc/*/mem rwklx,",
            "deny /sys/** wklx,",
            "signal (send, receive) peer=alloy-swebench-gate,",
            "deny signal (send, receive) peer=unconfined,",
        ):
            with self.subTest(rule=rule):
                self.assertIn(rule, policy)


if __name__ == "__main__":
    unittest.main()
