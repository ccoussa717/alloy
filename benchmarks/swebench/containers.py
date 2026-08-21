from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Sequence

from benchmarks.swebench.cleanup import CleanupUncertaintyError
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
UNAME_BIN = "/usr/bin/uname"
RUNC_BIN = "/usr/bin/runc"
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
    dns_servers: tuple[str, ...] = ()


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
    kernel_release: str
    runc_version: str
    runc_commit: str
    runc_spec: str


Runner = Callable[..., subprocess.CompletedProcess[str]]


class DaemonIdentityDriftError(RuntimeError):
    pass


class CleanupUncertainError(CleanupUncertaintyError):
    def __init__(
        self,
        handle: ContainerHandle,
        original_error: BaseException,
        cleanup_error: BaseException,
    ) -> None:
        self.handle = handle
        self.evidence = {
            "cleanup_verified": False,
            "container_id": handle.container_id,
            "name": handle.name,
            "run_id": handle.run_id,
        }
        super().__init__(
            "cleanup uncertain for "
            f"container {handle.name} ({handle.container_id}, run {handle.run_id}); "
            f"original failure: {original_error}; cleanup failure: {cleanup_error}",
            original_error=original_error,
            cleanup_errors=(cleanup_error,),
        )


class VolumeCleanupUncertainError(CleanupUncertaintyError):
    def __init__(
        self, name: str, run_id: str, original_error: BaseException, cleanup_error: BaseException,
    ) -> None:
        self.name = name
        self.run_id = run_id
        super().__init__(
            f"cleanup uncertain for volume {name} (run {run_id}); original failure: "
            f"{original_error}; cleanup failure: {cleanup_error}",
            original_error=original_error,
            cleanup_errors=(cleanup_error,),
        )


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
        before_run: Callable[[], None] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        prepared_arguments = list(arguments)
        if before_run is not None:
            before_run()
        return self.runner(
            prepared_arguments,
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

    @staticmethod
    def _handle_description(handle: ContainerHandle | None) -> str:
        if handle is None:
            return "pending container"
        return f"container {handle.name} ({handle.container_id}, run {handle.run_id})"

    def _assert_daemon_identity(self, handle: ContainerHandle | None = None) -> None:
        description = self._handle_description(handle)
        if self._daemon_identity is None:
            raise DaemonIdentityDriftError(
                f"cannot prove original Docker daemon identity for {description}"
            )
        try:
            current = self._current_daemon_identity()
        except Exception as error:
            raise DaemonIdentityDriftError(
                f"cannot prove original Docker daemon identity for {description}"
            ) from error
        if current != self._daemon_identity:
            raise DaemonIdentityDriftError(
                f"Docker daemon identity drifted after preflight for {description}"
            )

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

    @staticmethod
    def _kernel_release(result: subprocess.CompletedProcess[str]) -> str:
        lines = result.stdout.splitlines()
        if len(lines) != 1 or re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,127}", lines[0]) is None:
            raise RuntimeError("trusted kernel release probe returned malformed evidence")
        return lines[0]

    @staticmethod
    def _runc_evidence(result: subprocess.CompletedProcess[str]) -> tuple[str, str, str]:
        lines = result.stdout.splitlines()
        if not lines:
            raise RuntimeError("trusted runc version probe returned malformed evidence")
        version_match = re.fullmatch(
            r"runc version ([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)",
            lines[0],
        )
        if version_match is None:
            raise RuntimeError("trusted runc version probe returned malformed evidence")
        fields: dict[str, str] = {}
        allowed = {"commit", "spec", "go", "libseccomp", "criu"}
        for line in lines[1:]:
            match = re.fullmatch(r"([a-z][a-z0-9_-]*): ([\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)", line)
            if match is None or match.group(1) not in allowed or match.group(1) in fields:
                raise RuntimeError("trusted runc version probe returned malformed evidence")
            fields[match.group(1)] = match.group(2)
        commit = fields.get("commit")
        spec_version = fields.get("spec")
        if (
            commit is None
            or re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,127}", commit) is None
            or spec_version is None
            or re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", spec_version) is None
        ):
            raise RuntimeError("trusted runc version probe returned malformed evidence")
        return version_match.group(1), commit, spec_version

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
        kernel_release = self._kernel_release(self._run([UNAME_BIN, "-r"]))
        runc_version, runc_commit, runc_spec = self._runc_evidence(
            self._run([RUNC_BIN, "--version"])
        )
        if info.get("KernelVersion") != kernel_release:
            raise RuntimeError("Docker kernel release differs from the trusted host probe")
        docker_runc_commit = self._mapping(info.get("RuncCommit")).get("ID")
        if docker_runc_commit != runc_commit:
            raise RuntimeError("Docker runc commit differs from the trusted runtime probe")
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
            cgroup_version=cgroup_version,
            apparmor=apparmor,
            seccomp=seccomp,
            os_type=os_type,
            architecture=architecture,
            apparmor_name=policy.apparmor_name,
            seccomp_sha256=policy.seccomp_sha256,
            apparmor_sha256=policy.apparmor_sha256,
            profile_fingerprint=fingerprint,
            daemon_identity=daemon_identity,
            kernel_release=kernel_release,
            runc_version=runc_version,
            runc_commit=runc_commit,
            runc_spec=runc_spec,
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
        return self.verify_local_image(image)

    def verify_local_image(self, image: ImagePin) -> str:
        self._validate_image(image)
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
        if len(spec.dns_servers) > 3 or len(set(spec.dns_servers)) != len(spec.dns_servers):
            raise ValueError("DNS servers must be a unique bounded set of IP literals")
        for value in spec.dns_servers:
            try:
                address = ipaddress.ip_address(value)
            except ValueError as error:
                raise ValueError("DNS servers must be IP literals") from error
            if address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
                raise ValueError("DNS servers may not use local or special-purpose addresses")
        if IMAGE_ID.fullmatch(spec.image_id) is None:
            raise ValueError("expected image ID must be a sha256 digest")
        for mount in spec.mounts:
            self._validate_mount(mount)

    def _create_arguments(
        self,
        spec: ContainerSpec,
        *,
        user: str = CONTAINER_USER,
        cap_add: tuple[str, ...] = (),
    ) -> list[str]:
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
            user,
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
            "--cgroupns",
            "private",
            "--network",
            "none",
        ]
        for capability in cap_add:
            arguments.extend(("--cap-add", capability))
        for key, value in spec.environment:
            arguments.extend(("--env", f"{key}={value}"))
        for value in spec.dns_servers:
            arguments.extend(("--dns", value))
        for mount in spec.mounts:
            mount_type = mount.kind
            readonly = ",readonly" if mount.read_only else ""
            arguments.extend(
                (
                    "--mount",
                    f"type={mount_type},src={mount.source},dst={mount.target}{readonly}",
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

    def create(
        self,
        spec: ContainerSpec,
        *,
        before_create: Callable[[], None] | None = None,
    ) -> ContainerHandle:
        if self._completed_preflight != self._profile_fingerprint():
            raise RuntimeError("official preflight was not completed for this runtime and profile")
        self._verify_policy_bytes()
        self._validate_spec(spec)
        self._verify_volume_ownership(spec)
        self._assert_daemon_identity()
        arguments = self._create_arguments(spec)
        callback_completed = before_create is None

        def run_before_create() -> None:
            nonlocal callback_completed
            assert before_create is not None
            before_create()
            callback_completed = True

        try:
            result = self._run(
                arguments,
                before_run=run_before_create if before_create is not None else None,
            )
        except BaseException as original_error:
            if not callback_completed:
                raise
            pending = ContainerHandle(spec.name, spec.name, spec.run_id)
            try:
                self.force_remove(pending)
            except BaseException as cleanup_error:
                raise CleanupUncertainError(
                    pending, original_error, cleanup_error
                ) from original_error
            raise
        container_id = result.stdout.strip()
        if not container_id:
            raise RuntimeError("Docker create returned no container ID")
        handle = ContainerHandle(spec.name, container_id, spec.run_id)
        try:
            self._assert_daemon_identity(handle)
            self.inspect_security(handle, spec)
            self._assert_daemon_identity(handle)
            self._run(self._docker_arguments("start", container_id))
        except BaseException as original_error:
            try:
                self.force_remove(handle)
            except BaseException as cleanup_error:
                raise CleanupUncertainError(
                    handle, original_error, cleanup_error
                ) from original_error
            raise
        return handle

    def _inspect(self, identifier: str, *, check: bool = True) -> tuple[dict[str, object] | None, int]:
        result = self._run(
            self._docker_arguments("container", "inspect", identifier), check=check
        )
        if result.returncode != 0:
            stderr = result.stderr.lower()
            if "no such object" in stderr or "no such container" in stderr:
                return None, result.returncode
            raise RuntimeError("could not prove container absence from Docker inspection")
        return self._json_object(result, "container inspection"), 0

    def inspect_owned_container(
        self, handle: ContainerHandle, *, absent_ok: bool = False
    ) -> dict[str, object] | None:
        self._assert_daemon_identity(handle)
        inspected, returncode = self._inspect(handle.name, check=not absent_ok)
        if returncode != 0:
            return None
        assert inspected is not None
        config = self._mapping(inspected.get("Config"))
        labels = self._mapping(config.get("Labels"))
        container_id = inspected.get("Id")
        name = inspected.get("Name")
        if (
            labels.get(LABEL) != handle.run_id
            or not isinstance(container_id, str)
            or not container_id
            or not isinstance(name, str)
            or name.removeprefix("/") != handle.name
        ):
            raise RuntimeError("observed container ownership or identity drifted")
        self._assert_daemon_identity(handle)
        return {
            "container_id": container_id,
            "daemon_identity": asdict(self._daemon_identity),
            "inspection": json.loads(json.dumps(inspected)),
        }

    @staticmethod
    def _mapping(value: object) -> dict[str, object]:
        return value if isinstance(value, dict) else {}

    def inspect_security(
        self,
        handle: ContainerHandle,
        spec: ContainerSpec,
        *,
        expected_user: str = CONTAINER_USER,
        expected_cap_add: tuple[str, ...] = (),
        expected_networks: tuple[str, ...] = (),
    ) -> dict[str, object]:
        self._verify_policy_bytes()
        inspected, _ = self._inspect(handle.container_id)
        assert inspected is not None
        config = self._mapping(inspected.get("Config"))
        host = self._mapping(inspected.get("HostConfig"))
        network = self._mapping(inspected.get("NetworkSettings"))
        labels = self._mapping(config.get("Labels"))
        if config.get("User") != expected_user:
            raise RuntimeError("container does not use the required numeric non-root user")
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError("container ownership label drifted")
        if host.get("Privileged") is not False:
            raise RuntimeError("container is privileged")
        cap_drop = host.get("CapDrop")
        if not isinstance(cap_drop, list) or {str(value).upper() for value in cap_drop} != {"ALL"}:
            raise RuntimeError("container capability drop drifted")
        cap_add = host.get("CapAdd")
        actual_cap_add = () if cap_add in (None, []) else tuple(sorted(
            str(value).upper().removeprefix("CAP_") for value in cap_add
        ))
        if actual_cap_add != tuple(sorted(expected_cap_add)):
            raise RuntimeError("container capability add drifted")
        expected_options = {
            f"seccomp={self.seccomp_path}",
            f"apparmor={self.profile.security_policy.apparmor_name}",
        }
        options = host.get("SecurityOpt")
        if not isinstance(options, list) or any(not isinstance(value, str) for value in options):
            raise RuntimeError("container security options drifted")
        normalized = []
        for value in options:
            if value == "no-new-privileges":
                value = "no-new-privileges:true"
            elif value.startswith("seccomp={"):
                try:
                    observed_seccomp = json.loads(value.removeprefix("seccomp="))
                    expected_seccomp = json.loads(self.seccomp_path.read_text())
                except (OSError, json.JSONDecodeError):
                    pass
                else:
                    if observed_seccomp == expected_seccomp:
                        value = f"seccomp={self.seccomp_path}"
            normalized.append(value)
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
        if host.get("CgroupnsMode") != "private":
            raise RuntimeError("container cgroup namespace drifted")
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
        dns = host.get("Dns")
        actual_dns = () if dns in (None, []) else tuple(dns) if isinstance(dns, list) else None
        if actual_dns != spec.dns_servers:
            raise RuntimeError("container DNS configuration drifted")
        if inspected.get("Image") != spec.image_id:
            raise RuntimeError("container image ID drifted")
        networks = network.get("Networks")
        observed_networks = set(networks) if isinstance(networks, dict) else None
        expected_network_set = set(expected_networks)
        if observed_networks is None or (
            observed_networks not in (set(), {"none"})
            if not expected_network_set
            else observed_networks != expected_network_set
        ):
            raise RuntimeError("container network membership drifted")
        self._inspect_mounts(inspected.get("Mounts"), spec.mounts)
        return {
            "container_id": handle.container_id,
            "daemon_identity": (
                asdict(self._daemon_identity) if self._daemon_identity is not None else None
            ),
            "inspection": json.loads(json.dumps(inspected)),
        }

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

    def create_volume(self, name: str, run_id: str) -> None:
        if self._completed_preflight != self._profile_fingerprint():
            raise RuntimeError("official preflight was not completed for this runtime and profile")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+", name) is None:
            raise ValueError("Docker named volume must use a simple name")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", run_id) is None:
            raise ValueError("run ID must be safe for a Docker resource name")
        self._verify_policy_bytes()
        self._assert_daemon_identity()
        result = self._run(self._docker_arguments("volume", "inspect", name), check=False)
        if result.returncode == 0:
            raise RuntimeError("refusing to reuse an existing Docker volume")
        if "no such volume" not in result.stderr.lower():
            raise RuntimeError("could not prove Docker volume absence")
        self._assert_daemon_identity()
        created = False
        try:
            result = self._run(self._docker_arguments(
                "volume", "create", "--label", f"{LABEL}={run_id}", name
            ))
            created = True
            if result.stdout.strip() != name:
                raise RuntimeError("Docker created an unexpected volume")
            self._assert_daemon_identity()
            spec = ContainerSpec(
                name="volume-verification", run_id=run_id, image=self.profile.agent_image,
                image_id="sha256:" + "0" * 64, command=("true",),
                mounts=(MountSpec(name, "/volume", False, "volume"),),
            )
            self._verify_volume_ownership(spec)
            self._assert_daemon_identity()
        except BaseException as original_error:
            if created:
                try:
                    self.remove_volume(name, run_id)
                except BaseException as cleanup_error:
                    raise VolumeCleanupUncertainError(
                        name, run_id, original_error, cleanup_error,
                    ) from original_error
            raise

    def initialize_volume(
        self,
        name: str,
        target: str,
        run_id: str,
        image: ImagePin,
        image_id: str,
    ) -> None:
        if self._completed_preflight != self._profile_fingerprint():
            raise RuntimeError("official preflight was not completed for this runtime and profile")
        target_path = Path(target)
        if (
            not target_path.is_absolute()
            or ".." in target_path.parts
            or re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_./-]*", target) is None
        ):
            raise ValueError("volume initializer target must be a safe absolute path")
        spec = ContainerSpec(
            name=f"alloy-volume-init-{run_id}", run_id=run_id, image=image,
            image_id=image_id,
            command=("/bin/sh", "-euc", f"chown 65532:65532 {target}"),
            mounts=(MountSpec(name, target, False, "volume"),),
        )
        self._verify_policy_bytes()
        self._validate_spec(spec)
        self._assert_daemon_identity()
        self._verify_volume_ownership(spec)
        self._assert_daemon_identity()
        result = self._run(self._create_arguments(spec, user="0:0", cap_add=("CHOWN",)))
        container_id = result.stdout.strip()
        if not container_id:
            raise RuntimeError("Docker create returned no helper container ID")
        handle = ContainerHandle(spec.name, container_id, run_id)
        try:
            self._assert_daemon_identity(handle)
            self.inspect_security(
                handle, spec, expected_user="0:0", expected_cap_add=("CHOWN",),
            )
            self._assert_daemon_identity(handle)
            self._run(self._docker_arguments("start", container_id))
            if self.wait(handle, timeout=60) != 0:
                raise RuntimeError("confined volume initializer failed")
        except BaseException as original_error:
            try:
                self.force_remove(handle)
            except BaseException as cleanup_error:
                raise CleanupUncertainError(handle, original_error, cleanup_error) from original_error
            raise
        self.force_remove(handle)

    def remove_volume(self, name: str, run_id: str) -> None:
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+", name) is None:
            raise ValueError("Docker named volume must use a simple name")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", run_id) is None:
            raise ValueError("run ID must be safe for a Docker resource name")
        self._assert_daemon_identity()
        result = self._run(self._docker_arguments("volume", "inspect", name), check=False)
        self._assert_daemon_identity()
        if result.returncode != 0:
            if "no such volume" in result.stderr.lower():
                return
            raise RuntimeError("could not prove Docker volume state")
        inspected = self._json_object(result, "volume inspection")
        labels = self._mapping(inspected.get("Labels"))
        if inspected.get("Name") != name or labels.get(LABEL) != run_id:
            raise RuntimeError("named volume ownership label does not match the run")
        if (
            inspected.get("Driver") != "local"
            or inspected.get("Options") not in (None, {})
            or inspected.get("Scope") != "local"
        ):
            raise RuntimeError("named volume must be a plain local volume")
        self._assert_daemon_identity()
        self._run(self._docker_arguments("volume", "rm", name))
        self._assert_daemon_identity()
        absent = self._run(self._docker_arguments("volume", "inspect", name), check=False)
        self._assert_daemon_identity()
        if absent.returncode == 0 or "no such volume" not in absent.stderr.lower():
            raise RuntimeError("could not prove Docker volume removal")

    def force_remove(self, handle: ContainerHandle) -> None:
        self._assert_daemon_identity(handle)
        inspected, returncode = self._inspect(handle.name, check=False)
        if returncode != 0:
            return
        assert inspected is not None
        labels = self._mapping(self._mapping(inspected.get("Config")).get("Labels"))
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError(
                "container name was reused with a different ownership label: "
                f"expected {handle.run_id!r}, observed {labels.get(LABEL)!r}"
            )
        self._assert_daemon_identity(handle)
        self._run(self._docker_arguments("rm", "--force", handle.name))
        self.assert_absent(handle)

    def assert_absent(self, handle: ContainerHandle) -> None:
        self._assert_daemon_identity(handle)
        inspected, returncode = self._inspect(handle.name, check=False)
        if returncode != 0:
            return
        assert inspected is not None
        labels = self._mapping(self._mapping(inspected.get("Config")).get("Labels"))
        if labels.get(LABEL) != handle.run_id:
            raise RuntimeError("container name was reused with a different ownership label")
        raise RuntimeError("owned container still exists after forced teardown")
