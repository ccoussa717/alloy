from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Sequence

from benchmarks.swebench.profile import BenchmarkProfile, ImagePin


LABEL = "alloy.swebench.gate"
CONTAINER_USER = "65532:65532"
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
DOCKER_BIN = "/usr/bin/docker"
DOCKER_ENDPOINT = "unix:///var/run/docker.sock"
DOCKER_SOCKET = "/var/run/docker.sock"
DOCKER_SOCKET_CANONICAL = "/run/docker.sock"
APPARMOR_PARSER_BIN = "/usr/sbin/apparmor_parser"
AA_STATUS_BIN = "/usr/sbin/aa-status"
FIXED_ENV = MappingProxyType({
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
})


@dataclass(frozen=True)
class MountSpec:
    source: Path | str
    target: str
    read_only: bool
    kind: str


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
class DaemonIdentity:
    endpoint: str
    daemon_id: str
    name: str
    root_dir: str
    server_version: str


@dataclass(frozen=True)
class PreflightReport:
    cgroup_version: str
    apparmor: bool
    seccomp: bool
    os_type: str
    architecture: str
    apparmor_name: str
    seccomp_sha256: str
    apparmor_sha256: str
    profile_fingerprint: str
    daemon_identity: DaemonIdentity


Runner = Callable[..., subprocess.CompletedProcess[str]]


class _DaemonIdentityDrift(RuntimeError):
    pass


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
        self._completed_preflight: str | None = None
        self._daemon_identity: DaemonIdentity | None = None

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
            env=FIXED_ENV,
        )

    @staticmethod
    def _docker_arguments(*arguments: str) -> list[str]:
        return [DOCKER_BIN, "--host", DOCKER_ENDPOINT, *arguments]

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

    def _profile_fingerprint(self) -> str:
        encoded = json.dumps(
            asdict(self.profile), sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _validate_local_docker_socket() -> None:
        try:
            metadata = os.lstat(DOCKER_SOCKET)
            canonical = os.path.realpath(DOCKER_SOCKET)
        except OSError as error:
            raise RuntimeError("local Docker Unix socket is unavailable") from error
        if not stat.S_ISSOCK(metadata.st_mode):
            raise RuntimeError("local Docker endpoint must be a Unix socket")
        if metadata.st_uid != 0:
            raise RuntimeError("local Docker Unix socket must be root-owned")
        if canonical != DOCKER_SOCKET_CANONICAL:
            raise RuntimeError("local Docker socket is not at the expected canonical location")

    @staticmethod
    def _identity_from_info(info: dict[str, object]) -> DaemonIdentity:
        names = {
            "daemon_id": "ID",
            "name": "Name",
            "root_dir": "DockerRootDir",
            "server_version": "ServerVersion",
        }
        values: dict[str, str] = {}
        for field, key in names.items():
            value = info.get(key)
            if not isinstance(value, str) or not value:
                raise RuntimeError(f"Docker daemon identity field {key} is missing")
            values[field] = value
        return DaemonIdentity(endpoint=DOCKER_ENDPOINT, **values)

    def _current_daemon_identity(self) -> DaemonIdentity:
        self._validate_local_docker_socket()
        info = self._json_object(
            self._run(self._docker_arguments("info", "--format", "{{json .}}")),
            "host information",
        )
        return self._identity_from_info(info)

    def _assert_daemon_identity(self) -> None:
        if self._daemon_identity is None:
            raise RuntimeError("official preflight did not record a Docker daemon identity")
        if self._current_daemon_identity() != self._daemon_identity:
            raise _DaemonIdentityDrift("Docker daemon identity drifted after preflight")

    @staticmethod
    def _apparmor_profile_mode(status: dict[str, object], name: str) -> str | None:
        profiles = status.get("profiles")
        if isinstance(profiles, dict):
            value = profiles.get(name)
            if isinstance(value, str):
                return value
            if isinstance(value, dict):
                mode = value.get("mode", value.get("status"))
                return mode if isinstance(mode, str) else None
            return None
        if isinstance(profiles, list):
            matches = [
                value
                for value in profiles
                if isinstance(value, dict) and value.get("name") == name
            ]
            if len(matches) != 1:
                return None
            mode = matches[0].get("mode", matches[0].get("status"))
            return mode if isinstance(mode, str) else None
        return None

    def preflight(self) -> PreflightReport:
        self._completed_preflight = None
        self._daemon_identity = None
        if os.geteuid() != 0:
            raise RuntimeError("official container preflight must run as root")
        for variable in ("DOCKER_HOST", "DOCKER_CONTEXT"):
            if os.environ.get(variable):
                raise RuntimeError(f"official preflight rejects nonempty {variable}")
        self._validate_local_docker_socket()
        self._verify_policy_bytes()
        result = self._run(self._docker_arguments("info", "--format", "{{json .}}"))
        info = self._json_object(result, "host information")
        daemon_identity = self._identity_from_info(info)
        cgroup_version = str(info.get("CgroupVersion", ""))
        os_type = str(info.get("OSType", ""))
        architecture = str(info.get("Architecture", ""))
        options = info.get("SecurityOptions")
        security_options = options if isinstance(options, list) else []
        feature_names = {
            str(option).lower().split(",", 1)[0] for option in security_options
        }
        apparmor = "name=apparmor" in feature_names
        seccomp = "name=seccomp" in feature_names
        if cgroup_version != "2":
            raise RuntimeError("Docker host must use cgroup v2")
        if not apparmor:
            raise RuntimeError("Docker host must provide AppArmor")
        if not seccomp:
            raise RuntimeError("Docker host must provide seccomp")
        if os_type != "linux":
            raise RuntimeError("official runs require a Linux Docker daemon")
        if architecture not in {"amd64", "x86_64"}:
            raise RuntimeError("official runs require an amd64 Docker daemon")
        self._run([APPARMOR_PARSER_BIN, "-r", str(self.apparmor_path)])
        status = self._json_object(
            self._run([AA_STATUS_BIN, "--json"]), "AppArmor status"
        )
        policy = self.profile.security_policy
        mode = self._apparmor_profile_mode(status, policy.apparmor_name)
        if mode is None:
            raise RuntimeError("pinned AppArmor profile is not loaded")
        if mode.lower() != "enforce":
            raise RuntimeError("pinned AppArmor profile must be in enforce mode")
        fingerprint = self._profile_fingerprint()
        report = PreflightReport(
            cgroup_version,
            apparmor,
            seccomp,
            os_type,
            architecture,
            policy.apparmor_name,
            policy.seccomp_sha256,
            policy.apparmor_sha256,
            fingerprint,
            daemon_identity,
        )
        self._completed_preflight = fingerprint
        self._daemon_identity = daemon_identity
        return report

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
        self._run(self._docker_arguments("pull", "--platform", "linux/amd64", image.reference))
        metadata = self._json_object(
            self._run(self._docker_arguments("image", "inspect", image.reference)),
            "image inspection",
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

    def _validate_mount(self, mount: MountSpec) -> None:
        source = str(mount.source)
        if "," in source or "," in mount.target:
            raise ValueError("mount paths may not contain commas")
        if not mount.target.startswith("/"):
            raise ValueError("mount targets must be absolute")
        if mount.kind == "volume":
            if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+", source) is None:
                raise ValueError("Docker named volume must use a simple name")
            return
        if mount.kind != "bind":
            raise ValueError("mount kind must be bind or volume")
        source_path = mount.source if isinstance(mount.source, Path) else Path(mount.source)
        if not source_path.is_absolute():
            raise ValueError("bind mount source must be absolute")
        known_socket_roots = (
            Path("/run"),
            Path("/var/run"),
            Path("/var/lib/docker"),
        )
        if (
            "docker.sock" in source_path.parts
            or "docker.sock" in mount.target
            or any(source_path == root or source_path.is_relative_to(root) for root in known_socket_roots)
            or ".docker/run" in source_path.as_posix()
        ):
            raise ValueError("Docker socket source or ancestor mounts are forbidden")
        if not mount.read_only:
            raise ValueError("bind mounts must be read-only")
        try:
            resolved = source_path.resolve(strict=True)
        except OSError as error:
            raise ValueError("bind mount must be a regular authority file") from error
        if source_path != resolved:
            raise ValueError("bind mount source may not contain a symlink")
        if not resolved.is_relative_to(self.authority_root) or not resolved.is_file():
            raise ValueError("bind mount must be a regular authority file")

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
            DOCKER_BIN,
            "--host",
            DOCKER_ENDPOINT,
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
            mount_type = mount.kind
            arguments.extend(
                (
                    "--mount",
                    f"type={mount_type},src={mount.source},dst={mount.target},{mode}",
                )
            )
        return [*arguments, spec.image.reference, *spec.command]

    def _verify_volume_ownership(self, spec: ContainerSpec) -> None:
        for mount in spec.mounts:
            if mount.kind != "volume":
                continue
            name = str(mount.source)
            inspected = self._json_object(
                self._run(self._docker_arguments("volume", "inspect", name)),
                "volume inspection",
            )
            labels = self._mapping(inspected.get("Labels"))
            if inspected.get("Name") != name or labels.get(LABEL) != spec.run_id:
                raise RuntimeError("named volume ownership label does not match the run")
            if (
                inspected.get("Driver") != "local"
                or inspected.get("Options") not in (None, {})
                or inspected.get("Scope") != "local"
            ):
                raise RuntimeError("named volume must be a plain local volume")

    def create(self, spec: ContainerSpec) -> ContainerHandle:
        if self._completed_preflight != self._profile_fingerprint():
            raise RuntimeError("official preflight was not completed for this runtime and profile")
        self._verify_policy_bytes()
        self._validate_spec(spec)
        self._verify_volume_ownership(spec)
        self._assert_daemon_identity()
        result = self._run(self._create_arguments(spec))
        container_id = result.stdout.strip()
        if not container_id:
            raise RuntimeError("Docker create returned no container ID")
        handle = ContainerHandle(spec.name, container_id, spec.run_id)
        try:
            self.inspect_security(handle, spec)
            self._assert_daemon_identity()
            self._run(self._docker_arguments("start", container_id))
        except _DaemonIdentityDrift:
            raise
        except BaseException:
            self.force_remove(handle)
            raise
        return handle

    def _inspect(self, identifier: str, *, check: bool = True) -> tuple[dict[str, object] | None, int]:
        result = self._run(self._docker_arguments("inspect", identifier), check=check)
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
        if not isinstance(options, list) or any(not isinstance(value, str) for value in options):
            raise RuntimeError("container security options drifted")
        normalized = [
            "no-new-privileges:true" if value == "no-new-privileges" else value
            for value in options
        ]
        expected_options.add("no-new-privileges:true")
        if len(normalized) != 3 or len(set(normalized)) != 3 or set(normalized) != expected_options:
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
            (
                mount.get("Type"),
                mount.get("Name") if mount.get("Type") == "volume" else mount.get("Source"),
                mount.get("Destination"),
                mount.get("RW"),
            )
            for mount in value
            if isinstance(mount, dict)
        }
        wanted = {
            (mount.kind, str(mount.source), mount.target, not mount.read_only)
            for mount in expected
        }
        if actual != wanted:
            raise RuntimeError("container mounts drifted")

    def wait(self, handle: ContainerHandle, *, timeout: int | None = None) -> int:
        result = self._run(
            self._docker_arguments("wait", handle.container_id), timeout=timeout
        )
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
        self._run(self._docker_arguments("rm", "--force", handle.name))
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
