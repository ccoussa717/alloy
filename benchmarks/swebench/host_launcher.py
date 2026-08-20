#!/usr/bin/python3
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence


LAUNCHER_PATH = Path("/usr/local/libexec/alloy-swebench-gate")
CONFIG_PATH = Path("/etc/alloy/swebench-gate.json")
STATE_ROOT = Path("/var/lib/alloy-swebench-gate")
AUTHORITY_ROOT = STATE_ROOT / "authority"
PRIVATE_KEY_PATH = STATE_ROOT / "gate-key.pem"
PUBLIC_KEY_PATH = STATE_ROOT / "gate-key.pub.pem"
CANONICAL_REMOTE = "https://github.com/ccoussa717/alloy.git"
FIXED_ENV = {
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}
FULL_SHA = re.compile(r"[0-9a-f]{40}")

# The installed launcher lives outside the authority checkout, so add only the
# fixed root before importing reviewed coordinator modules.
if Path(__file__).resolve() == LAUNCHER_PATH and str(AUTHORITY_ROOT) not in sys.path:
    sys.path.insert(0, str(AUTHORITY_ROOT))

from benchmarks.swebench.attempts import (  # noqa: E402
    AttemptKey,
    GateSigner,
    SignedClaim,
    authorize_retry,
    verify_claim,
)
from benchmarks.swebench.authority import (  # noqa: E402
    HostConfig,
    coordinator_tree_digest,
    load_host_config,
    load_policy_from_commit,
    verify_candidate,
)
from benchmarks.swebench.containers import DockerRuntime  # noqa: E402
from benchmarks.swebench.coordinator import (  # noqa: E402
    COORDINATOR_PATHS,
    TrustedCoordinator,
    TrustedRunServices,
    TrustedServiceConfig,
)
from benchmarks.swebench.dataset import canonical_json_bytes  # noqa: E402
from benchmarks.swebench.evaluator import EvaluatorEnvironment  # noqa: E402
from benchmarks.swebench.fetch import ArtifactFetcher  # noqa: E402
from benchmarks.swebench.profile import BenchmarkProfile, load_profile  # noqa: E402
from benchmarks.swebench.proxy import ProxyNetwork  # noqa: E402
from benchmarks.swebench.runner import run  # noqa: E402


@dataclass(frozen=True)
class HostPaths:
    launcher: Path = LAUNCHER_PATH
    config: Path = CONFIG_PATH
    state: Path = STATE_ROOT
    authority: Path = AUTHORITY_ROOT
    private_key: Path = PRIVATE_KEY_PATH
    public_key: Path = PUBLIC_KEY_PATH

    @classmethod
    def from_provision(cls, paths) -> "HostPaths":
        return cls(
            paths.launcher,
            paths.config,
            paths.state,
            paths.authority,
            paths.private_key,
            paths.public_key,
        )


@dataclass(frozen=True)
class TrustedHost:
    paths: HostPaths
    config: HostConfig
    profile: BenchmarkProfile


def _run_git(repository: Path, *arguments: str) -> str:
    previous_umask = os.umask(0o077)
    try:
        result = subprocess.run(
            ["/usr/bin/git", *arguments],
            cwd=repository,
            env=FIXED_ENV,
            text=True,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("authority Git verification failed") from error
    finally:
        os.umask(previous_umask)
    return result.stdout


def _no_symlink_ancestors(path: Path, label: str) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            details = current.lstat()
        except OSError as error:
            raise ValueError(f"{label} is missing") from error
        if stat.S_ISLNK(details.st_mode):
            raise ValueError(f"{label} has a symlinked ancestor")


def _secure_file(path: Path, label: str, mode: int, expected_uid: int) -> None:
    _no_symlink_ancestors(path, label)
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{label} must be a regular file")
    if details.st_uid != expected_uid:
        raise ValueError(f"{label} must be owned by root")
    if stat.S_IMODE(details.st_mode) != mode:
        raise ValueError(f"{label} must have mode {mode:04o}")


def _secure_directory(path: Path, label: str, mode: int, expected_uid: int) -> None:
    _no_symlink_ancestors(path, label)
    details = path.lstat()
    if not stat.S_ISDIR(details.st_mode):
        raise ValueError(f"{label} must be a directory")
    if details.st_uid != expected_uid:
        raise ValueError(f"{label} must be owned by root")
    if stat.S_IMODE(details.st_mode) != mode:
        raise ValueError(f"{label} must have mode {mode:04o}")


def _secure_tree(path: Path, expected_uid: int) -> None:
    _no_symlink_ancestors(path, "authority checkout")
    for candidate in (path, *path.rglob("*")):
        details = candidate.lstat()
        if stat.S_ISLNK(details.st_mode):
            raise ValueError("authority checkout must not contain symlinks")
        if details.st_uid != expected_uid:
            raise ValueError("authority checkout must be owned by root")
        if details.st_mode & 0o022:
            raise ValueError("authority checkout must not be group- or other-writable")


def _reject_authority_overrides(environment: Mapping[str, str]) -> None:
    forbidden = {
        "ALLOY_SWEBENCH_AUTHORITY",
        "ALLOY_SWEBENCH_CONFIG",
        "ALLOY_SWEBENCH_LAUNCHER",
        "ALLOY_SWEBENCH_STATE",
    }
    if forbidden.intersection(environment):
        raise ValueError("authority path override environment variables are forbidden")


def _verify_checkout(paths: HostPaths, authority_commit: str, expected_uid: int) -> None:
    top = _run_git(paths.authority, "rev-parse", "--show-toplevel").strip()
    if top != str(paths.authority):
        raise ValueError("authority checkout is not at the fixed canonical path")
    head = _run_git(paths.authority, "rev-parse", "HEAD").strip()
    if head != authority_commit:
        raise ValueError("authority checkout does not match the configured authority commit")
    if _run_git(paths.authority, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("authority checkout must be clean")
    remote = _run_git(paths.authority, "remote", "get-url", "github").strip()
    if remote != CANONICAL_REMOTE:
        raise ValueError("authority checkout must use the canonical GitHub remote")
    _secure_tree(paths.authority, expected_uid)


def load_trusted_host(paths: HostPaths = HostPaths(), *, expected_uid: int = 0) -> TrustedHost:
    _secure_directory(paths.state, "protected state", 0o700, expected_uid)
    _secure_directory(paths.config.parent, "host config directory", 0o755, expected_uid)
    _secure_directory(paths.launcher.parent, "host launcher directory", 0o755, expected_uid)
    _secure_file(paths.config, "host config", 0o600, expected_uid)
    _secure_file(paths.launcher, "host launcher", 0o755, expected_uid)
    _secure_file(paths.private_key, "gate private key", 0o600, expected_uid)
    _secure_file(paths.public_key, "gate public key", 0o644, expected_uid)
    config = load_host_config(paths.config)
    _verify_checkout(paths, config.authority_commit, expected_uid)

    expected_launcher = _run_git(
        paths.authority,
        "show",
        f"{config.authority_commit}:benchmarks/swebench/host_launcher.py",
    ).encode()
    if paths.launcher.read_bytes() != expected_launcher:
        raise ValueError("installed host launcher differs from the authority blob")
    observed_tree = coordinator_tree_digest(
        paths.authority, config.authority_commit, COORDINATOR_PATHS
    )
    if observed_tree != config.coordinator_tree_sha256:
        raise ValueError("coordinator tree digest differs from host config")
    profile = load_profile(
        paths.authority / "benchmarks/swebench/profile.json", paths.authority
    )
    observed_policies = {
        "apparmor": profile.security_policy.apparmor_sha256,
        "seccomp": profile.security_policy.seccomp_sha256,
    }
    if observed_policies != dict(config.confinement_policy_sha256):
        raise ValueError("confinement policy digests differ from host config")
    public_key_digest = hashlib.sha256(paths.public_key.read_bytes()).hexdigest()
    if public_key_digest != config.gate_public_key_sha256:
        raise ValueError("gate public key digest differs from host config")
    return TrustedHost(paths, config, profile)


def _candidate_is_advertised(repository: Path, candidate: str) -> None:
    advertised = _run_git(repository, "ls-remote", "github")
    if not any(
        line.split("\t", 1)[0] == candidate
        and "\trefs/" in line
        and not line.endswith("^{}")
        for line in advertised.splitlines()
    ):
        raise ValueError("candidate commit is not an advertised canonical ref tip")
    _run_git(repository, "fetch", "--no-tags", "github", candidate)
    if _run_git(repository, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("authority checkout became dirty while fetching candidate")


def _attempt_key(host: TrustedHost, candidate_commit: str) -> AttemptKey:
    candidate = verify_candidate(
        host.paths.authority,
        host.config.authority_commit,
        candidate_commit,
        load_policy_from_commit(host.paths.authority, host.config.authority_commit),
    )
    profile_value = json.loads(json.dumps(asdict(host.profile)))
    authority_profile_digest = hashlib.sha256(
        canonical_json_bytes(
            {
                "authority_commit": host.config.authority_commit,
                "profile": profile_value,
            }
        )
    ).hexdigest()
    return AttemptKey(
        candidate.candidate_commit,
        host.profile.instance_id,
        host.profile.dataset.revision,
        host.profile.dataset.row_sha256,
        host.profile.model_digest,
        authority_profile_digest,
    )


def _retry_claim(host: TrustedHost, key: AttemptKey) -> SignedClaim | None:
    digest = hashlib.sha256(key.canonical_bytes()).hexdigest()
    path = host.paths.state / f"{digest}.attempt-2.claim.json"
    if not path.exists():
        return None
    claim = SignedClaim.from_bytes(path.read_bytes())
    verify_claim(claim, host.paths.public_key, key)
    return claim


def _coordinator(host: TrustedHost, candidate_commit: str) -> TrustedCoordinator:
    runtime = DockerRuntime(host.profile, host.paths.authority)
    runtime.preflight()
    proxy_image_id = runtime.verify_local_image(host.profile.proxy_image)
    cache = host.paths.authority / "benchmarks/swebench/.cache"
    fetcher = ArtifactFetcher(
        host.paths.authority,
        cache / "artifacts",
        profile=host.profile,
        target_repository=cache / "target.git",
    )
    evaluator_python = host.paths.authority / "benchmarks/swebench/.venv/bin/python"
    evaluator = EvaluatorEnvironment(
        host.profile, host.paths.authority, evaluator_python, runtime=runtime
    )
    ollama_origin = "http://127.0.0.1:11434"
    proxy = ProxyNetwork(
        runtime,
        proxy_image_id,
        host.paths.authority,
        ollama_origin,
    )
    key = _attempt_key(host, candidate_commit)
    services = TrustedRunServices(
        TrustedServiceConfig(
            repository=host.paths.authority,
            authority_commit=host.config.authority_commit,
            host_config=host.config,
            profile=host.profile,
            runtime=runtime,
            fetcher=fetcher,
            evaluator=evaluator,
            proxy=proxy,
            signer=GateSigner(host.paths.private_key),
            public_key=host.paths.public_key,
            state_dir=host.paths.state,
            results_root=host.paths.state / "results",
            work_root=host.paths.state / "work",
            ollama_origin=ollama_origin,
            retry_claim=_retry_claim(host, key),
        )
    )
    return TrustedCoordinator(services)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if os.geteuid() != 0:
        print("error: trusted host launcher requires root", file=sys.stderr)
        return 2
    try:
        _reject_authority_overrides(os.environ)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
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
    if mode not in {"dry-run", "release", "authorize-retry"}:
        print("error: invalid launcher mode", file=sys.stderr)
        return 64

    os.environ.clear()
    os.environ.update(FIXED_ENV)
    try:
        host = load_trusted_host()
        _candidate_is_advertised(host.paths.authority, candidate_commit)
        if mode == "authorize-retry":
            claim = authorize_retry(
                host.paths.state,
                _attempt_key(host, candidate_commit),
                arguments[2],
                GateSigner(host.paths.private_key),
            )
            print(claim.canonical_bytes().decode("utf-8"))
            return 0
        return run(_coordinator(host, candidate_commit), mode, candidate_commit)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
