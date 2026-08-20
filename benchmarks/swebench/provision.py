#!/usr/bin/python3
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

SOURCE_ROOT = Path(__file__).resolve().parents[2]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from benchmarks.swebench.authority import coordinator_tree_digest, load_host_config
from benchmarks.swebench.coordinator import COORDINATOR_PATHS
from benchmarks.swebench.profile import load_profile


FULL_SHA = re.compile(r"[0-9a-f]{40}")
CANONICAL_REMOTE = "https://github.com/ccoussa717/alloy.git"
FIXED_ENV = {
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
}


@dataclass(frozen=True)
class ProvisionPaths:
    launcher: Path = Path("/usr/local/libexec/alloy-swebench-gate")
    config: Path = Path("/etc/alloy/swebench-gate.json")
    state: Path = Path("/var/lib/alloy-swebench-gate")
    authority: Path = Path("/var/lib/alloy-swebench-gate/authority")
    private_key: Path = Path("/var/lib/alloy-swebench-gate/gate-key.pem")
    public_key: Path = Path("/var/lib/alloy-swebench-gate/gate-key.pub.pem")

    @classmethod
    def under(cls, root: Path) -> "ProvisionPaths":
        root = root.resolve()
        state = root / "var/lib/alloy-swebench-gate"
        return cls(
            root / "usr/local/libexec/alloy-swebench-gate",
            root / "etc/alloy/swebench-gate.json",
            state,
            state / "authority",
            state / "gate-key.pem",
            state / "gate-key.pub.pem",
        )

    def all_paths(self) -> tuple[Path, ...]:
        return (
            self.launcher,
            self.config,
            self.state,
            self.authority,
            self.private_key,
            self.public_key,
        )


def _command(arguments: Sequence[str], *, cwd: Path | None = None) -> str:
    previous_umask = os.umask(0o077)
    try:
        result = subprocess.run(
            list(arguments),
            cwd=cwd,
            env=FIXED_ENV,
            text=True,
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError(f"provisioning command failed: {arguments[0]}") from error
    finally:
        os.umask(previous_umask)
    return result.stdout


def _git(repository: Path, *arguments: str) -> str:
    return _command(("/usr/bin/git", *arguments), cwd=repository)


def _verify_source(repository: Path, authority: str, require_remote_tip: bool) -> None:
    if FULL_SHA.fullmatch(authority) is None:
        raise ValueError("authority commit must be a full lowercase Git SHA")
    repository = repository.resolve()
    if _git(repository, "rev-parse", "--show-toplevel").strip() != str(repository):
        raise ValueError("provisioning source is not a canonical checkout root")
    if _git(repository, "rev-parse", "HEAD").strip() != authority:
        raise ValueError("checked-out authority does not match the requested authority SHA")
    if _git(repository, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("authority source checkout must be clean")
    if _git(repository, "remote", "get-url", "github").strip() != CANONICAL_REMOTE:
        raise ValueError("authority source must use the canonical GitHub remote")
    if require_remote_tip:
        main = _git(repository, "ls-remote", "github", "refs/heads/main").splitlines()
        if main != [f"{authority}\trefs/heads/main"]:
            raise ValueError("authority SHA must be the just-merged canonical main tip")


def _mkdir(path: Path, mode: int, owner_uid: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(mode)
    if path.stat().st_uid != owner_uid:
        raise ValueError(f"provisioning directory is not owned by uid {owner_uid}: {path}")


def _write_atomic(path: Path, content: bytes, mode: int, owner_uid: int) -> None:
    _mkdir(path.parent, 0o755, owner_uid)
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
        )
        try:
            view = memoryview(content)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("short provisioning write")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        temporary.chmod(mode)
        if temporary.stat().st_uid != owner_uid:
            raise ValueError("provisioned file has unexpected ownership")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _clone_authority(source: Path, authority: str, destination: Path) -> None:
    _command(
        (
            "/usr/bin/git",
            "clone",
            "--quiet",
            "--no-hardlinks",
            "--no-checkout",
            str(source),
            str(destination),
        )
    )
    _git(destination, "remote", "set-url", "origin", CANONICAL_REMOTE)
    if "github" in _git(destination, "remote").splitlines():
        _git(destination, "remote", "remove", "github")
    _git(destination, "remote", "rename", "origin", "github")
    _git(destination, "checkout", "--quiet", "--detach", authority)
    if _git(destination, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("installed authority checkout is not clean")


def _copy_prepared_environment(source: Path, destination: Path) -> None:
    prepared = (
        Path("benchmarks/swebench/.venv"),
        Path("benchmarks/swebench/.cache/target.git"),
    )
    for relative in prepared:
        source_path = source / relative
        if not source_path.is_dir() or source_path.is_symlink():
            raise ValueError(f"setup must prepare {relative} before provisioning")
        if any(path.is_symlink() for path in source_path.rglob("*")):
            raise ValueError(f"prepared environment contains a symlink: {relative}")
        destination_path = destination / relative
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_path, destination_path)


def _verify_tree_ownership(root: Path, owner_uid: int) -> None:
    for path in (root, *root.rglob("*")):
        details = path.lstat()
        if stat.S_ISLNK(details.st_mode):
            raise ValueError("provisioned authority tree must not contain symlinks")
        if details.st_uid != owner_uid:
            raise ValueError("provisioned authority tree has unexpected ownership")
        if details.st_mode & 0o022:
            path.chmod(stat.S_IMODE(details.st_mode) & ~0o022)


def _generate_keys(paths: ProvisionPaths, owner_uid: int) -> None:
    private = paths.state / f".{paths.private_key.name}.{os.getpid()}.tmp"
    public = paths.state / f".{paths.public_key.name}.{os.getpid()}.tmp"
    try:
        _command(("/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)))
        _command(
            (
                "/usr/bin/openssl",
                "pkey",
                "-in",
                str(private),
                "-pubout",
                "-out",
                str(public),
            )
        )
        private.chmod(0o600)
        public.chmod(0o644)
        if private.stat().st_uid != owner_uid or public.stat().st_uid != owner_uid:
            raise ValueError("generated gate key has unexpected ownership")
        os.replace(private, paths.private_key)
        os.replace(public, paths.public_key)
    except BaseException:
        private.unlink(missing_ok=True)
        public.unlink(missing_ok=True)
        raise


def _load_apparmor(path: Path) -> None:
    _command(("/usr/sbin/apparmor_parser", "-r", str(path)))


def _config(authority_root: Path, authority: str, public_key: Path) -> dict[str, object]:
    profile = load_profile(
        authority_root / "benchmarks/swebench/profile.json", authority_root
    )
    return {
        "authority_commit": authority,
        "coordinator_tree_sha256": coordinator_tree_digest(
            authority_root, authority, COORDINATOR_PATHS
        ),
        "confinement_policy_sha256": {
            "apparmor": profile.security_policy.apparmor_sha256,
            "seccomp": profile.security_policy.seccomp_sha256,
        },
        "gate_public_key_sha256": hashlib.sha256(public_key.read_bytes()).hexdigest(),
    }


def _provision(
    source: Path,
    authority: str,
    paths: ProvisionPaths = ProvisionPaths(),
    *,
    replace_authority: tuple[str, str] | None = None,
    owner_uid: int = 0,
    require_remote_tip: bool = True,
    apparmor_loader: Callable[[Path], None] = _load_apparmor,
) -> dict[str, object]:
    _verify_source(source, authority, require_remote_tip)
    replacing = replace_authority is not None
    if replacing:
        old_authority, new_authority = replace_authority
        if authority != new_authority or old_authority == new_authority:
            raise ValueError("replacement authority arguments are inconsistent")
        existing = load_host_config(paths.config)
        if existing.authority_commit != old_authority:
            raise ValueError("old authority does not match the provisioned authority")
    elif any(path.exists() or path.is_symlink() for path in (
        paths.config,
        paths.authority,
        paths.private_key,
        paths.public_key,
        paths.launcher,
    )):
        raise FileExistsError("SWE-bench gate is already provisioned; use --replace-authority")

    _mkdir(paths.state, 0o700, owner_uid)
    _mkdir(paths.launcher.parent, 0o755, owner_uid)
    _mkdir(paths.config.parent, 0o755, owner_uid)
    if not replacing:
        _generate_keys(paths, owner_uid)
    else:
        for path, mode in ((paths.private_key, 0o600), (paths.public_key, 0o644)):
            details = path.lstat()
            if not stat.S_ISREG(details.st_mode) or details.st_uid != owner_uid:
                raise ValueError("existing gate key has unsafe ownership or type")
            if stat.S_IMODE(details.st_mode) != mode:
                raise ValueError("existing gate key has unsafe mode")

    staging = Path(tempfile.mkdtemp(prefix=".authority-", dir=paths.state))
    staging.rmdir()
    backup = paths.state / f".authority-backup-{os.getpid()}"
    swapped = False
    try:
        _clone_authority(source.resolve(), authority, staging)
        _copy_prepared_environment(source.resolve(), staging)
        _verify_tree_ownership(staging, owner_uid)
        candidate_config = _config(staging, authority, paths.public_key)
        launcher_content = (
            staging / "benchmarks/swebench/host_launcher.py"
        ).read_bytes()
        if replacing:
            os.replace(paths.authority, backup)
        os.replace(staging, paths.authority)
        swapped = True
        apparmor_loader(
            paths.authority
            / "benchmarks/swebench/policies/alloy-swebench-gate.apparmor"
        )
        _write_atomic(paths.launcher, launcher_content, 0o755, owner_uid)
        config_bytes = (
            json.dumps(candidate_config, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        _write_atomic(paths.config, config_bytes, 0o600, owner_uid)
        if backup.exists():
            shutil.rmtree(backup)
    except BaseException:
        if swapped and backup.exists():
            failed = paths.state / f".authority-failed-{os.getpid()}"
            os.replace(paths.authority, failed)
            os.replace(backup, paths.authority)
            shutil.rmtree(failed)
        elif swapped:
            shutil.rmtree(paths.authority)
        if staging.exists():
            shutil.rmtree(staging)
        if not replacing:
            paths.config.unlink(missing_ok=True)
            paths.launcher.unlink(missing_ok=True)
            paths.private_key.unlink(missing_ok=True)
            paths.public_key.unlink(missing_ok=True)
        raise

    receipt = {
        "schema_version": 1,
        "action": "replace-authority" if replacing else "provision",
        **candidate_config,
        "paths": {
            "authority": str(paths.authority),
            "config": str(paths.config),
            "launcher": str(paths.launcher),
            "public_key": str(paths.public_key),
            "state": str(paths.state),
        },
    }
    if replace_authority is not None:
        receipt["previous_authority_commit"] = replace_authority[0]
    return receipt


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if os.geteuid() != 0:
        print("error: provisioning requires root", file=sys.stderr)
        return 2
    replace_authority = None
    if len(arguments) == 1 and FULL_SHA.fullmatch(arguments[0]):
        authority = arguments[0]
    elif (
        len(arguments) == 3
        and arguments[0] == "--replace-authority"
        and FULL_SHA.fullmatch(arguments[1])
        and FULL_SHA.fullmatch(arguments[2])
    ):
        replace_authority = (arguments[1], arguments[2])
        authority = arguments[2]
    else:
        print(
            "usage: provision.py <authority-sha> | "
            "--replace-authority <old-sha> <new-sha>",
            file=sys.stderr,
        )
        return 64
    source = SOURCE_ROOT
    try:
        receipt = _provision(
            source,
            authority,
            replace_authority=replace_authority,
        )
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
