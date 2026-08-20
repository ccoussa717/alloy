import copy
import json
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
            completed("container-id\n"),
            completed(json.dumps([self.inspection()])),
            completed(),
        )

        handle = self.preflighted_runtime(runner).create(self.spec)

        seccomp = REPO_ROOT / self.profile.security_policy.seccomp_path
        self.assertEqual(
            runner.calls[4][0],
            [
                "docker", "create", "--name", "alloy-agent-run-123",
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
                "--mount", "type=volume,src=alloy-checkout-run-123,dst=/workspace,rw",
                self.image.reference,
                "node", "agent.js",
            ],
        )
        self.assertEqual(
            runner.calls[3][0],
            ["docker", "volume", "inspect", "alloy-checkout-run-123"],
        )
        self.assertEqual(runner.calls[5][0], ["docker", "inspect", "container-id"])
        self.assertEqual(runner.calls[6][0], ["docker", "start", "container-id"])
        self.assertEqual(handle, ContainerHandle("alloy-agent-run-123", "container-id", "run-123"))

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
        self.assertEqual(runner.calls[0][0], ["docker", "info", "--format", "{{json .}}"])
        self.assertEqual(runner.calls[1][0], ["apparmor_parser", "-r", str(APPARMOR_PATH)])
        self.assertEqual(runner.calls[2][0], ["aa-status", "--json"])

        amd64_info = {**self.docker_info(), "Architecture": "amd64"}
        amd64_runner = ScriptedRunner(
            completed(json.dumps(amd64_info)), completed(),
            completed(json.dumps({"profiles": {"alloy-swebench-gate": "enforce"}})),
        )
        self.assertEqual(self.runtime(amd64_runner).preflight().architecture, "amd64")

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
            ["docker", "pull", "--platform", "linux/amd64", self.image.reference],
        )
        self.assertEqual(runner.calls[1][0], ["docker", "image", "inspect", self.image.reference])

        for change, message in (
            ({"Architecture": "arm64"}, "linux/amd64"),
            ({"RepoDigests": ["node@sha256:" + "f" * 64]}, "manifest digest"),
            ({"Id": "not-a-digest"}, "image ID"),
        ):
            bad = {**metadata, **change}
            runtime = self.runtime(ScriptedRunner(completed(), completed(json.dumps([bad]))))
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                runtime.pull_and_verify(self.image)

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
            completed("container-id\n"),
            completed(json.dumps([inspected])),
            completed(json.dumps([self.inspection()])),
            completed(),
            absent(),
        )

        with self.assertRaisesRegex(RuntimeError, "privileged"):
            self.preflighted_runtime(runner).create(self.spec)

        self.assertEqual(runner.calls[6][0], ["docker", "inspect", "alloy-agent-run-123"])
        self.assertEqual(runner.calls[7][0], ["docker", "rm", "--force", "alloy-agent-run-123"])
        self.assertEqual(runner.calls[8][0], ["docker", "inspect", "alloy-agent-run-123"])

    def test_force_remove_checks_label_and_asserts_absence(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        runner = ScriptedRunner(
            completed(json.dumps([self.inspection()])), completed(), absent()
        )
        runtime = self.runtime(runner)
        runtime.force_remove(handle)
        self.assertEqual(runner.calls[1][0], ["docker", "rm", "--force", self.spec.name])

        reused = self.inspection()
        reused["Config"]["Labels"]["alloy.swebench.gate"] = "other-run"
        runner = ScriptedRunner(completed(json.dumps([reused])))
        with self.assertRaisesRegex(RuntimeError, "different ownership label"):
            self.runtime(runner).force_remove(handle)
        self.assertEqual(len(runner.calls), 1)

    def test_assert_absent_fails_closed_when_docker_inspection_fails(self):
        handle = ContainerHandle(self.spec.name, "container-id", self.spec.run_id)
        runner = ScriptedRunner(completed(returncode=1, stderr="daemon unavailable\n"))
        with self.assertRaisesRegex(RuntimeError, "could not prove container absence"):
            self.runtime(runner).assert_absent(handle)

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
            completed("container-id\n"),
            completed(json.dumps([inspected])),
            completed(),
        )

        self.preflighted_runtime(runner).create(spec)

        self.assertIn(
            "type=bind,src=" + str(APPARMOR_PATH) + ",dst=/policy,ro",
            runner.calls[3][0],
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
        self.assertEqual(runner.calls[0][0], ["docker", "wait", "container-id"])
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
