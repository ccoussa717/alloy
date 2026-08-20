from __future__ import annotations

import hashlib
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from benchmarks.swebench.profile import BenchmarkProfile, ImagePin


LABEL = "alloy.swebench.gate"
CONTAINER_USER = "65532:65532"
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


@dataclass(frozen=True)
class MountSpec:
    source: Path
    target: str
    read_only: bool
    trusted: bool = False


@dataclass(frozen=True)
class ContainerSpec:
    name: str
    run_id: str
    image: ImagePin
    image_id: str
    command: tuple[str, ...]
    mounts: tuple[MountSpec, ...] = ()
    environment: tuple[tuple[str, str], ...] = ()
    network_mode: str = "none"
    privileged: bool = False
    pid_mode: str = ""
    ipc_mode: str = "private"
    uts_mode: str = ""
    devices: tuple[str, ...] = ()


@dataclass(frozen=True)
class ContainerHandle:
    name: str
    container_id: str
    run_id: str


@dataclass(frozen=True)
class PreflightReport:
    cgroup_version: str
    apparmor: bool
    seccomp: bool


Runner = Callable[..., subprocess.CompletedProcess[str]]


class DockerRuntime:
    def __init__(
        self,
        profile: BenchmarkProfile,
        authority_root: Path,
        *,
        runner: Runner = subprocess.run,
    ) -> None:
        self.profile = profile
        self.authority_root = authority_root.resolve()
        self.runner = runner
        self.seccomp_path = (
            self.authority_root / profile.security_policy.seccomp_path
        ).resolve()
        self.apparmor_path = (
            self.authority_root / profile.security_policy.apparmor_path
        ).resolve()

    def _run(
        self,
        arguments: Sequence[str],
        *,
        check: bool = True,
        timeout: int | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return self.runner(
            list(arguments),
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )

    @staticmethod
    def _json_object(result: subprocess.CompletedProcess[str], label: str) -> dict[str, object]:
        try:
            value = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Docker returned invalid {label} JSON") from error
        if isinstance(value, list) and len(value) == 1:
            value = value[0]
        if not isinstance(value, dict):
            raise RuntimeError(f"Docker returned invalid {label} JSON")
        return value

    @staticmethod
    def _digest(path: Path, label: str) -> str:
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise RuntimeError(f"{label} policy is unavailable") from error

    def _verify_policy_bytes(self) -> None:
        policy = self.profile.security_policy
        if self._digest(self.seccomp_path, "seccomp") != policy.seccomp_sha256:
            raise RuntimeError("seccomp policy digest does not match the pinned profile")
        if self._digest(self.apparmor_path, "AppArmor") != policy.apparmor_sha256:
            raise RuntimeError("AppArmor policy digest does not match the pinned profile")

    def preflight(self) -> PreflightReport:
        self._verify_policy_bytes()
        result = self._run(["docker", "info", "--format", "{{json .}}"])
        info = self._json_object(result, "host information")
        cgroup_version = str(info.get("CgroupVersion", ""))
        options = info.get("SecurityOptions")
        security_options = options if isinstance(options, list) else []
        apparmor = any("apparmor" in str(option).lower() for option in security_options)
        seccomp = any("seccomp" in str(option).lower() for option in security_options)
        if cgroup_version != "2":
            raise RuntimeError("Docker host must use cgroup v2")
        if not apparmor:
            raise RuntimeError("Docker host must provide AppArmor")
        if not seccomp:
            raise RuntimeError("Docker host must provide seccomp")
        return PreflightReport(cgroup_version, apparmor, seccomp)

    @staticmethod
    def _validate_image(image: ImagePin) -> None:
        if (
            image.platform != "linux/amd64"
            or not image.reference.endswith(f"@{image.manifest_digest}")
            or re.fullmatch(r"sha256:[0-9a-f]{64}", image.manifest_digest) is None
        ):
            raise ValueError("image must be digest-qualified for linux/amd64")

    def pull_and_verify(self, image: ImagePin) -> str:
        self._validate_image(image)
        self._run(["docker", "pull", "--platform", "linux/amd64", image.reference])
        metadata = self._json_object(
            self._run(["docker", "image", "inspect", image.reference]), "image inspection"
        )
        if metadata.get("Os") != "linux" or metadata.get("Architecture") != "amd64":
            raise RuntimeError("pulled image must be linux/amd64")
        repo_digests = metadata.get("RepoDigests")
        if not isinstance(repo_digests, list) or not any(
            isinstance(value, str) and value.endswith(f"@{image.manifest_digest}")
            for value in repo_digests
        ):
            raise RuntimeError("pulled image manifest digest does not match the pin")
        image_id = metadata.get("Id")
        if not isinstance(image_id, str) or IMAGE_ID.fullmatch(image_id) is None:
            raise RuntimeError("Docker returned an invalid image ID")
        return image_id

    @staticmethod
    def _validate_mount(mount: MountSpec) -> None:
        source = str(mount.source)
        resolved_source = str(mount.source.resolve())
        if (
            "docker.sock" in source
            or "docker.sock" in resolved_source
            or "docker.sock" in mount.target
        ):
            raise ValueError("Docker socket mounts are forbidden")
        if mount.trusted and not mount.read_only:
            raise ValueError("trusted mount must be read-only")
        if not mount.source.is_absolute() or not mount.target.startswith("/"):
            raise ValueError("mount paths must be absolute")
        if "," in source or "," in mount.target:
            raise ValueError("mount paths may not contain commas")

    def _validate_spec(self, spec: ContainerSpec) -> None:
        self._validate_image(spec.image)
        if not spec.name or not spec.run_id or not spec.command:
            raise ValueError("container name, run ID, and command are required")
        if spec.privileged:
            raise ValueError("privileged containers are forbidden")
        if spec.pid_mode == "host":
            raise ValueError("host PID namespace is forbidden")
        if spec.ipc_mode == "host":
            raise ValueError("host IPC namespace is forbidden")
        if spec.uts_mode == "host":
            raise ValueError("host UTS namespace is forbidden")
        if spec.network_mode == "host":
            raise ValueError("host network namespace is forbidden")
        if spec.network_mode != "none":
            raise ValueError("untrusted containers must use the none network")
        if spec.devices:
            raise ValueError("devices are forbidden")
        if IMAGE_ID.fullmatch(spec.image_id) is None:
            raise ValueError("expected image ID must be a sha256 digest")
        for mount in spec.mounts:
            self._validate_mount(mount)

    def _create_arguments(self, spec: ContainerSpec) -> list[str]:
        policy = self.profile.security_policy
        limits = self.profile.limits
        arguments = [
            "docker",
            "create",
            "--name",
            spec.name,
            "--label",
            f"{LABEL}={spec.run_id}",
            "--platform",
            "linux/amd64",
            "--user",
            CONTAINER_USER,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--security-opt",
            f"seccomp={self.seccomp_path}",
            "--security-opt",
            f"apparmor={policy.apparmor_name}",
            "--read-only",
            "--init",
            "--pids-limit",
            str(limits.pids),
            "--memory",
            str(limits.memory_bytes),
            "--cpus",
            str(limits.cpus),
            "--network",
            "none",
        ]
        for key, value in spec.environment:
            arguments.extend(("--env", f"{key}={value}"))
        for mount in spec.mounts:
            mode = "ro" if mount.read_only else "rw"
            arguments.extend(
                ("--mount", f"type=bind,src={mount.source},dst={mount.target},{mode}")
            )
        return [*arguments, spec.image.reference, *spec.command]

    def create(self, spec: ContainerSpec) -> ContainerHandle:
        self._verify_policy_bytes()
        self._validate_spec(spec)
        result = self._run(self._create_arguments(spec))
        container_id = result.stdout.strip()
        if not container_id:
            raise RuntimeError("Docker create returned no container ID")
        handle = ContainerHandle(spec.name, container_id, spec.run_id)
        try:
            self.inspect_security(handle, spec)
            self._run(["docker", "start", container_id])
        except BaseException:
            self.force_remove(handle)
            raise
        return handle

    def _inspect(self, identifier: str, *, check: bool = True) -> tuple[dict[str, object] | None, int]:
        result = self._run(["docker", "inspect", identifier], check=check)
        if result.returncode != 0:
            if "No such object" in result.stderr or "No such container" in result.stderr:
                return None, result.returncode
            raise RuntimeError("could not prove container absence from Docker inspection")
        return self._json_object(result, "container inspection"), 0

    @staticmethod
    def _mapping(value: object) -> dict[str, object]:
        return value if isinstance(value, dict) else {}

    def inspect_security(self, handle: ContainerHandle, spec: ContainerSpec) -> None:
        inspected, _ = self._inspect(handle.container_id)
        assert inspected is not None
        config = self._mapping(inspected.get("Config"))
        host = self._mapping(inspected.get("HostConfig"))
        network = self._mapping(inspected.get("NetworkSettings"))
        labels = self._mapping(config.get("Labels"))
        if config.get("User") != CONTAINER_USER:
            raise RuntimeError("container does not use the required numeric non-root user")
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError("container ownership label drifted")
        if host.get("Privileged") is not False:
            raise RuntimeError("container is privileged")
        cap_drop = host.get("CapDrop")
        if not isinstance(cap_drop, list) or {str(value).upper() for value in cap_drop} != {"ALL"}:
            raise RuntimeError("container capability drop drifted")
        expected_options = {
            f"seccomp={self.seccomp_path}",
            f"apparmor={self.profile.security_policy.apparmor_name}",
        }
        options = host.get("SecurityOpt")
        option_set = {str(value) for value in options} if isinstance(options, list) else set()
        no_new_privileges = bool(
            {"no-new-privileges", "no-new-privileges:true"} & option_set
        )
        if not no_new_privileges or not expected_options.issubset(option_set):
            raise RuntimeError("container security options drifted")
        if host.get("ReadonlyRootfs") is not True:
            raise RuntimeError("container read-only root filesystem drifted")
        if host.get("Init") is not True:
            raise RuntimeError("container init setting drifted")
        if host.get("PidsLimit") != self.profile.limits.pids:
            raise RuntimeError("container PID limit drifted")
        if host.get("Memory") != self.profile.limits.memory_bytes:
            raise RuntimeError("container memory limit drifted")
        if host.get("NanoCpus") != self.profile.limits.cpus * 1_000_000_000:
            raise RuntimeError("container CPU limit drifted")
        if host.get("PidMode") not in ("", None):
            raise RuntimeError("container PID namespace drifted")
        if host.get("IpcMode") not in ("", "private", None):
            raise RuntimeError("container IPC namespace drifted")
        if host.get("UTSMode") not in ("", None):
            raise RuntimeError("container UTS namespace drifted")
        if host.get("NetworkMode") != "none":
            raise RuntimeError("container network namespace drifted")
        if host.get("Devices") not in ([], None):
            raise RuntimeError("container devices drifted")
        if inspected.get("Image") != spec.image_id:
            raise RuntimeError("container image ID drifted")
        networks = network.get("Networks")
        if not isinstance(networks, dict) or set(networks) - {"none"}:
            raise RuntimeError("container network membership drifted")
        self._inspect_mounts(inspected.get("Mounts"), spec.mounts)

    @staticmethod
    def _inspect_mounts(value: object, expected: tuple[MountSpec, ...]) -> None:
        if not isinstance(value, list) or len(value) != len(expected):
            raise RuntimeError("container mounts drifted")
        actual = {
            (mount.get("Source"), mount.get("Destination"), mount.get("RW"))
            for mount in value
            if isinstance(mount, dict)
        }
        wanted = {(str(mount.source), mount.target, not mount.read_only) for mount in expected}
        if actual != wanted:
            raise RuntimeError("container mounts drifted")

    def wait(self, handle: ContainerHandle, *, timeout: int | None = None) -> int:
        result = self._run(["docker", "wait", handle.container_id], timeout=timeout)
        try:
            return int(result.stdout.strip())
        except ValueError as error:
            raise RuntimeError("Docker wait returned an invalid exit code") from error

    def force_remove(self, handle: ContainerHandle) -> None:
        inspected, returncode = self._inspect(handle.name, check=False)
        if returncode != 0:
            return
        assert inspected is not None
        labels = self._mapping(self._mapping(inspected.get("Config")).get("Labels"))
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError("container name was reused with a different ownership label")
        self._run(["docker", "rm", "--force", handle.name])
        self.assert_absent(handle)

    def assert_absent(self, handle: ContainerHandle) -> None:
        inspected, returncode = self._inspect(handle.name, check=False)
        if returncode != 0:
            return
        assert inspected is not None
        labels = self._mapping(self._mapping(inspected.get("Config")).get("Labels"))
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError("container name was reused with a different ownership label")
        raise RuntimeError("owned container still exists after forced teardown")
