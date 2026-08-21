#!/usr/bin/env -S /usr/bin/python3 -I -E -s
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Sequence


LAUNCHER_PATH = Path("/usr/local/libexec/alloy-swebench-gate")
CONFIG_PATH = Path("/etc/alloy/swebench-gate.json")
STATE_ROOT = Path("/var/lib/alloy-swebench-gate")
AUTHORITY_ROOT = STATE_ROOT / "authority"
PRIVATE_KEY_PATH = STATE_ROOT / "gate-key.pem"
PUBLIC_KEY_PATH = STATE_ROOT / "gate-key.pub.pem"
GIT_HOME_PATH = STATE_ROOT / "git-home"
FILESYSTEM_ROOT = Path("/")
REQUIRED_UID = 0
CANONICAL_REMOTE = "https://github.com/ccoussa717/alloy.git"
FULL_SHA = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
FIXED_ENV = {
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}
COORDINATOR_PATHS = (
    "benchmarks/swebench/artifacts.py",
    "benchmarks/swebench/attempts.py",
    "benchmarks/swebench/authority.py",
    "benchmarks/swebench/checkout.py",
    "benchmarks/swebench/cleanup.py",
    "benchmarks/swebench/containers.py",
    "benchmarks/swebench/coordinator.py",
    "benchmarks/swebench/dataset.py",
    "benchmarks/swebench/evaluator.py",
    "benchmarks/swebench/fetch.py",
    "benchmarks/swebench/install.py",
    "benchmarks/swebench/patches/swebench-5.0.0-run-evaluation.patch",
    "benchmarks/swebench/policies/alloy-swebench-gate.apparmor",
    "benchmarks/swebench/policies/untrusted-seccomp.json",
    "benchmarks/swebench/profile.json",
    "benchmarks/swebench/profile.py",
    "benchmarks/swebench/proxy.py",
    "benchmarks/swebench/proxy_server.py",
    "benchmarks/swebench/release-transform.json",
    "benchmarks/swebench/requirements.lock",
    "benchmarks/swebench/runner.py",
)


@dataclass(frozen=True)
class HostPaths:
    launcher: Path = LAUNCHER_PATH
    config: Path = CONFIG_PATH
    state: Path = STATE_ROOT
    authority: Path = AUTHORITY_ROOT
    private_key: Path = PRIVATE_KEY_PATH
    public_key: Path = PUBLIC_KEY_PATH
    git_home: Path = GIT_HOME_PATH
    root: Path = FILESYSTEM_ROOT

    @classmethod
    def from_provision(cls, paths) -> "HostPaths":
        return cls(
            paths.launcher,
            paths.config,
            paths.state,
            paths.authority,
            paths.private_key,
            paths.public_key,
            paths.git_home,
            paths.root,
        )


@dataclass(frozen=True)
class HostConfig:
    authority_commit: str
    coordinator_tree_sha256: str
    confinement_policy_sha256: Mapping[str, str]
    gate_public_key_sha256: str


@dataclass(frozen=True)
class TrustedHost:
    paths: HostPaths
    config: HostConfig
    profile_json: Mapping[str, object]


def _reject_authority_overrides(environment: Mapping[str, str]) -> None:
    if any(name.startswith("PYTHON") for name in environment):
        raise ValueError("Python environment variables are forbidden")
    forbidden = {
        "ALLOY_SWEBENCH_AUTHORITY",
        "ALLOY_SWEBENCH_CONFIG",
        "ALLOY_SWEBENCH_LAUNCHER",
        "ALLOY_SWEBENCH_STATE",
    }
    if forbidden.intersection(environment):
        raise ValueError("authority path override environment variables are forbidden")


def _fixed_environment() -> None:
    os.environ.clear()
    os.environ.update(FIXED_ENV)
    os.umask(0o077)


def _activate_trusted_environment(git_home: Path) -> None:
    os.environ.update(
        {
            "HOME": str(git_home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ALLOW_PROTOCOL": "https",
            "GIT_CONFIG_COUNT": "5",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": "/dev/null",
            "GIT_CONFIG_KEY_1": "core.fsmonitor",
            "GIT_CONFIG_VALUE_1": "false",
            "GIT_CONFIG_KEY_2": "credential.helper",
            "GIT_CONFIG_VALUE_2": "",
            "GIT_CONFIG_KEY_3": "protocol.file.allow",
            "GIT_CONFIG_VALUE_3": "never",
            "GIT_CONFIG_KEY_4": "protocol.ext.allow",
            "GIT_CONFIG_VALUE_4": "never",
        }
    )


def _open_nofollow(
    path: Path,
    *,
    root: Path,
    directory: bool,
    label: str,
    uid: int,
) -> int:
    if not path.is_absolute() or not root.is_absolute() or ".." in path.parts:
        raise ValueError(f"{label} must use a fixed absolute path")
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise ValueError(f"{label} escaped the fixed filesystem root") from error
    current = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _check_fd(
            current,
            label="filesystem root",
            uid=uid,
            mode=None,
            directory=True,
        )
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            flags = os.O_RDONLY | os.O_NOFOLLOW
            if not final or directory:
                flags |= os.O_DIRECTORY
            next_fd = os.open(part, flags, dir_fd=current)
            if not final:
                try:
                    _check_fd(
                        next_fd,
                        label=f"{label} parent",
                        uid=uid,
                        mode=None,
                        directory=True,
                    )
                except BaseException:
                    os.close(next_fd)
                    raise
            os.close(current)
            current = next_fd
        return current
    except OSError as error:
        os.close(current)
        raise ValueError(f"{label} is missing, unsafe, or has a symlinked ancestor") from error
    except BaseException:
        os.close(current)
        raise


def _check_fd(
    fd: int, *, label: str, uid: int, mode: int | None, directory: bool
) -> None:
    details = os.fstat(fd)
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(details.st_mode):
        raise ValueError(f"{label} has the wrong file type")
    if details.st_uid != uid:
        raise ValueError(f"{label} must be owned by root")
    if mode is None and details.st_mode & 0o022:
        raise ValueError(f"{label} must not be group- or other-writable")
    if mode is not None and stat.S_IMODE(details.st_mode) != mode:
        raise ValueError(f"{label} must have mode {mode:04o}")


def _secure_path(
    path: Path,
    *,
    root: Path,
    label: str,
    uid: int,
    mode: int | None,
    directory: bool,
) -> int:
    fd = _open_nofollow(path, root=root, directory=directory, label=label, uid=uid)
    try:
        _check_fd(fd, label=label, uid=uid, mode=mode, directory=directory)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _read_fd(fd: int, label: str, limit: int = 1024 * 1024) -> bytes:
    details = os.fstat(fd)
    if details.st_size < 0 or details.st_size > limit:
        raise ValueError(f"{label} is oversized")
    os.lseek(fd, 0, os.SEEK_SET)
    content = bytearray()
    while len(content) < details.st_size:
        chunk = os.read(fd, details.st_size - len(content))
        if not chunk:
            raise ValueError(f"{label} changed while being read")
        content.extend(chunk)
    if os.read(fd, 1):
        raise ValueError(f"{label} changed while being read")
    return bytes(content)


def _sha256_fd(fd: int, label: str) -> str:
    return hashlib.sha256(_read_fd(fd, label, 64 * 1024 * 1024)).hexdigest()


def _run_git(repository: Path, git_home: Path, *arguments: str, text: bool = True):
    try:
        result = subprocess.run(
            [
                "/usr/bin/env",
                "-i",
                f"HOME={git_home}",
                "PATH=/usr/bin:/bin",
                "GIT_CONFIG_NOSYSTEM=1",
                "GIT_CONFIG_GLOBAL=/dev/null",
                "GIT_CONFIG_SYSTEM=/dev/null",
                "GIT_TERMINAL_PROMPT=0",
                "GIT_ALLOW_PROTOCOL=https",
                "/usr/bin/git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "credential.helper=",
                "-c",
                "protocol.file.allow=never",
                "-c",
                "protocol.ext.allow=never",
                *arguments,
            ],
            cwd=repository,
            env=FIXED_ENV,
            text=text,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("authority Git verification failed") from error
    return result.stdout


def _hash(value: object, label: str, length: int) -> str:
    pattern = FULL_SHA if length == 40 else SHA256
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase hash")
    if value == "0" * length:
        raise ValueError(f"{label} must not be an all-zero placeholder")
    return value


def _parse_config(content: bytes) -> HostConfig:
    try:
        raw = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("host config is invalid") from error
    expected = {
        "authority_commit",
        "coordinator_tree_sha256",
        "confinement_policy_sha256",
        "gate_public_key_sha256",
    }
    if not isinstance(raw, dict) or set(raw) != expected:
        raise ValueError("host config must contain exactly the reviewed keys")
    policies = raw["confinement_policy_sha256"]
    if not isinstance(policies, dict) or set(policies) != {"apparmor", "seccomp"}:
        raise ValueError("host config confinement policies are invalid")
    return HostConfig(
        _hash(raw["authority_commit"], "authority_commit", 40),
        _hash(raw["coordinator_tree_sha256"], "coordinator_tree_sha256", 64),
        MappingProxyType(
            {
                name: _hash(value, f"confinement_policy_sha256.{name}", 64)
                for name, value in policies.items()
            }
        ),
        _hash(raw["gate_public_key_sha256"], "gate_public_key_sha256", 64),
    )


def _coordinator_tree_digest(repository: Path, authority: str, git_home: Path) -> str:
    output = _run_git(
        repository,
        git_home,
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        authority,
        text=False,
    )
    entries = {}
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        entries[raw_path.decode("utf-8", "strict")] = (mode, object_type, object_id)
    digest = hashlib.sha256()
    for path in sorted(COORDINATOR_PATHS):
        try:
            mode, object_type, object_id = entries[path]
        except KeyError as error:
            raise ValueError(f"coordinator digest path is missing: {path}") from error
        digest.update(f"{mode}\0{object_type}\0{object_id}\0{path}\0".encode())
    return digest.hexdigest()


def _verify_checkout(paths: HostPaths, config: HostConfig, expected_uid: int) -> None:
    authority_fd = _secure_path(
        paths.authority,
        root=paths.root,
        label="authority checkout",
        uid=expected_uid,
        mode=0o700,
        directory=True,
    )
    os.close(authority_fd)
    top = _run_git(paths.authority, paths.git_home, "rev-parse", "--show-toplevel").strip()
    if top != str(paths.authority):
        raise ValueError("authority checkout is not at the fixed canonical path")
    if _run_git(paths.authority, paths.git_home, "rev-parse", "HEAD").strip() != config.authority_commit:
        raise ValueError("authority checkout does not match the configured authority commit")
    if _run_git(
        paths.authority,
        paths.git_home,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    ):
        raise ValueError("authority checkout must be clean")
    if _run_git(
        paths.authority, paths.git_home, "remote", "get-url", "github"
    ).strip() != CANONICAL_REMOTE:
        raise ValueError("authority checkout must use the canonical GitHub remote")
    observed = _coordinator_tree_digest(
        paths.authority, config.authority_commit, paths.git_home
    )
    if observed != config.coordinator_tree_sha256:
        raise ValueError("coordinator tree digest differs from host config")


def _profile_and_policies(paths: HostPaths, config: HostConfig, uid: int):
    profile_path = paths.authority / "benchmarks/swebench/profile.json"
    profile_fd = _secure_path(
        profile_path,
        root=paths.root,
        label="authority profile",
        uid=uid,
        mode=None,
        directory=False,
    )
    try:
        profile = json.loads(_read_fd(profile_fd, "authority profile"))
    finally:
        os.close(profile_fd)
    if not isinstance(profile, dict):
        raise ValueError("authority profile must be a JSON object")
    policy = profile.get("security_policy")
    if not isinstance(policy, dict):
        raise ValueError("authority profile security policy is invalid")
    observed = {}
    for name in ("apparmor", "seccomp"):
        relative = policy.get(f"{name}_path")
        expected = policy.get(f"{name}_sha256")
        if (
            not isinstance(relative, str)
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or not isinstance(expected, str)
        ):
            raise ValueError("authority profile policy paths or hashes are invalid")
        policy_fd = _secure_path(
            paths.authority / relative,
            root=paths.root,
            label=f"{name} policy",
            uid=uid,
            mode=None,
            directory=False,
        )
        try:
            observed[name] = _sha256_fd(policy_fd, f"{name} policy")
        finally:
            os.close(policy_fd)
        if observed[name] != expected:
            raise ValueError(f"{name} policy differs from authority profile")
    if observed != dict(config.confinement_policy_sha256):
        raise ValueError("confinement policy digests differ from host config")
    return MappingProxyType(profile)


def load_trusted_host(paths: HostPaths = HostPaths(), *, expected_uid: int = REQUIRED_UID) -> TrustedHost:
    state_fd = _secure_path(
        paths.state,
        root=paths.root,
        label="protected state",
        uid=expected_uid,
        mode=0o700,
        directory=True,
    )
    config_parent_fd = _secure_path(
        paths.config.parent,
        root=paths.root,
        label="host config directory",
        uid=expected_uid,
        mode=0o755,
        directory=True,
    )
    launcher_parent_fd = _secure_path(
        paths.launcher.parent,
        root=paths.root,
        label="host launcher directory",
        uid=expected_uid,
        mode=0o755,
        directory=True,
    )
    git_home_fd = _secure_path(
        paths.git_home,
        root=paths.root,
        label="launcher Git HOME",
        uid=expected_uid,
        mode=0o700,
        directory=True,
    )
    try:
        git_home_entries = os.listdir(git_home_fd)
    finally:
        os.close(git_home_fd)
    if git_home_entries:
        raise ValueError("launcher Git HOME must be empty")
    os.close(state_fd)
    os.close(config_parent_fd)
    os.close(launcher_parent_fd)
    config_fd = _secure_path(
        paths.config,
        root=paths.root,
        label="host config",
        uid=expected_uid,
        mode=0o600,
        directory=False,
    )
    launcher_fd = _secure_path(
        paths.launcher,
        root=paths.root,
        label="host launcher",
        uid=expected_uid,
        mode=0o755,
        directory=False,
    )
    private_fd = _secure_path(
        paths.private_key,
        root=paths.root,
        label="gate private key",
        uid=expected_uid,
        mode=0o600,
        directory=False,
    )
    public_fd = _secure_path(
        paths.public_key,
        root=paths.root,
        label="gate public key",
        uid=expected_uid,
        mode=0o644,
        directory=False,
    )
    try:
        config = _parse_config(_read_fd(config_fd, "host config"))
        launcher_digest = _sha256_fd(launcher_fd, "host launcher")
        public_digest = _sha256_fd(public_fd, "gate public key")
    finally:
        os.close(config_fd)
        os.close(launcher_fd)
        os.close(private_fd)
        os.close(public_fd)
    _verify_checkout(paths, config, expected_uid)
    expected_launcher = _run_git(
        paths.authority,
        paths.git_home,
        "show",
        f"{config.authority_commit}:benchmarks/swebench/host_launcher.py",
        text=False,
    )
    if hashlib.sha256(expected_launcher).hexdigest() != launcher_digest:
        raise ValueError("installed host launcher differs from the authority blob")
    if public_digest != config.gate_public_key_sha256:
        raise ValueError("gate public key digest differs from host config")
    profile = _profile_and_policies(paths, config, expected_uid)
    return TrustedHost(paths, config, profile)


def _candidate_is_advertised(repository: Path, git_home: Path, candidate: str) -> None:
    advertised = _run_git(
        repository, git_home, "ls-remote", "github", "refs/heads/main"
    )
    if advertised.splitlines() != [f"{candidate}\trefs/heads/main"]:
        raise ValueError("candidate commit is not the advertised canonical main tip")
    _run_git(
        repository, git_home, "fetch", "--no-tags", "github", "refs/heads/main"
    )
    fetched = _run_git(
        repository, git_home, "rev-parse", "--verify", "FETCH_HEAD^{commit}"
    ).strip()
    if fetched != candidate:
        raise ValueError("fetched canonical main tip differs from candidate commit")
    if _run_git(
        repository, git_home, "status", "--porcelain=v1", "--untracked-files=all"
    ):
        raise ValueError("authority checkout became dirty while fetching candidate")


# AUTHORITY_IMPORT_BOUNDARY
def _authority_main(host: TrustedHost, mode: str, candidate_commit: str, reason: str | None) -> int:
    sys.path.insert(0, str(host.paths.authority))
    from dataclasses import asdict

    from benchmarks.swebench.attempts import (
        AttemptKey,
        GateSigner,
        SignedClaim,
        authorize_retry,
        verify_claim,
    )
    from benchmarks.swebench.authority import (
        HostConfig as AuthorityHostConfig,
        load_policy_from_commit,
        verify_candidate,
    )
    from benchmarks.swebench.containers import DockerRuntime
    from benchmarks.swebench.coordinator import (
        TrustedCoordinator,
        TrustedRunServices,
        TrustedServiceConfig,
    )
    from benchmarks.swebench.dataset import canonical_json_bytes
    from benchmarks.swebench.evaluator import EvaluatorEnvironment
    from benchmarks.swebench.fetch import ArtifactFetcher
    from benchmarks.swebench.profile import load_profile
    from benchmarks.swebench.proxy import ProxyNetwork
    from benchmarks.swebench.runner import run

    authority_config = AuthorityHostConfig(
        host.config.authority_commit,
        host.config.coordinator_tree_sha256,
        host.config.confinement_policy_sha256,
        host.config.gate_public_key_sha256,
    )
    profile = load_profile(
        host.paths.authority / "benchmarks/swebench/profile.json", host.paths.authority
    )
    candidate = verify_candidate(
        host.paths.authority,
        host.config.authority_commit,
        candidate_commit,
        load_policy_from_commit(host.paths.authority, host.config.authority_commit),
    )
    profile_value = json.loads(json.dumps(asdict(profile)))
    authority_profile_digest = hashlib.sha256(
        canonical_json_bytes(
            {"authority_commit": host.config.authority_commit, "profile": profile_value}
        )
    ).hexdigest()
    key = AttemptKey(
        candidate.candidate_commit,
        profile.instance_id,
        profile.dataset.revision,
        profile.dataset.row_sha256,
        profile.model_digest,
        authority_profile_digest,
    )
    signer = GateSigner(host.paths.private_key)
    if mode == "authorize-retry":
        claim = authorize_retry(host.paths.state, key, reason or "", signer)
        print(claim.canonical_bytes().decode("utf-8"))
        return 0
    digest = hashlib.sha256(key.canonical_bytes()).hexdigest()
    retry_path = host.paths.state / f"{digest}.attempt-2.claim.json"
    retry_claim = None
    if retry_path.exists():
        retry_claim = SignedClaim.from_bytes(retry_path.read_bytes())
        verify_claim(retry_claim, host.paths.public_key, key)
    runtime = DockerRuntime(profile, host.paths.authority)
    runtime.preflight()
    proxy_image_id = runtime.verify_local_image(profile.proxy_image)
    cache = host.paths.authority / "benchmarks/swebench/.cache"
    fetcher = ArtifactFetcher(
        host.paths.authority,
        cache / "artifacts",
        profile=profile,
        target_repository=cache / "target.git",
    )
    evaluator = EvaluatorEnvironment(
        profile,
        host.paths.authority,
        host.paths.authority / "benchmarks/swebench/.venv/bin/python",
        runtime=runtime,
    )
    ollama_origin = "http://127.0.0.1:11434"
    proxy = ProxyNetwork(runtime, proxy_image_id, host.paths.authority, ollama_origin)
    services = TrustedRunServices(
        TrustedServiceConfig(
            repository=host.paths.authority,
            authority_commit=host.config.authority_commit,
            host_config=authority_config,
            profile=profile,
            runtime=runtime,
            fetcher=fetcher,
            evaluator=evaluator,
            proxy=proxy,
            signer=signer,
            public_key=host.paths.public_key,
            state_dir=host.paths.state,
            results_root=host.paths.state / "results",
            work_root=host.paths.state / "work",
            ollama_origin=ollama_origin,
            retry_claim=retry_claim,
        )
    )
    return run(TrustedCoordinator(services), mode, candidate_commit)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if os.geteuid() != REQUIRED_UID:
        print("error: trusted host launcher requires root", file=sys.stderr)
        return 2
    try:
        _reject_authority_overrides(os.environ)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    _fixed_environment()
    if len(arguments) not in {2, 3}:
        print(
            "usage: alloy-swebench-gate {dry-run|release} <candidate-sha> | "
            "authorize-retry <candidate-sha> <reason>",
            file=sys.stderr,
        )
        return 64
    mode, candidate_commit = arguments[:2]
    if FULL_SHA.fullmatch(candidate_commit) is None:
        print("error: candidate commit must be a full lowercase Git SHA", file=sys.stderr)
        return 64
    if (mode in {"dry-run", "release"} and len(arguments) != 2) or (
        mode == "authorize-retry" and len(arguments) != 3
    ):
        print("error: invalid launcher arguments", file=sys.stderr)
        return 64
    if mode == "authorize-retry" and not arguments[2].strip():
        print("error: invalid launcher arguments", file=sys.stderr)
        return 64
    if mode not in {"dry-run", "release", "authorize-retry"}:
        print("error: invalid launcher mode", file=sys.stderr)
        return 64
    try:
        host = load_trusted_host()
        _activate_trusted_environment(host.paths.git_home)
        _candidate_is_advertised(
            host.paths.authority, host.paths.git_home, candidate_commit
        )
        return _authority_main(
            host,
            mode,
            candidate_commit,
            arguments[2] if mode == "authorize-retry" else None,
        )
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
