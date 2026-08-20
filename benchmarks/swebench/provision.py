#!/usr/bin/env -S /usr/bin/python3 -I -E -s
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

SOURCE_ROOT = Path(__file__).resolve().parents[2]
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from benchmarks.swebench.authority import coordinator_tree_digest
from benchmarks.swebench.coordinator import COORDINATOR_PATHS
from benchmarks.swebench.evaluator import locked_distributions
from benchmarks.swebench.profile import load_profile


FULL_SHA = re.compile(r"[0-9a-f]{40}")
CANONICAL_REMOTE = "https://github.com/ccoussa717/alloy.git"
PYPI_INDEX = "https://pypi.org/simple"
TARGET_REMOTE = "https://github.com/astropy/astropy.git"
FIXED_ENV = {
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "PIP_CONFIG_FILE": "/dev/null",
    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    "PIP_NO_INPUT": "1",
}
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@dataclass(frozen=True)
class ProvisionPaths:
    launcher: Path = Path("/usr/local/libexec/alloy-swebench-gate")
    config: Path = Path("/etc/alloy/swebench-gate.json")
    state: Path = Path("/var/lib/alloy-swebench-gate")
    authority: Path = Path("/var/lib/alloy-swebench-gate/authority")
    private_key: Path = Path("/var/lib/alloy-swebench-gate/gate-key.pem")
    public_key: Path = Path("/var/lib/alloy-swebench-gate/gate-key.pub.pem")
    root: Path = Path("/")

    @classmethod
    def under(cls, root: Path) -> "ProvisionPaths":
        root = root.absolute()
        state = root / "var/lib/alloy-swebench-gate"
        return cls(
            root / "usr/local/libexec/alloy-swebench-gate",
            root / "etc/alloy/swebench-gate.json",
            state,
            state / "authority",
            state / "gate-key.pem",
            state / "gate-key.pub.pem",
            root,
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

    def relative(self, path: Path) -> tuple[str, ...]:
        try:
            return path.relative_to(self.root).parts
        except ValueError as error:
            raise ValueError("provisioning path escaped the fixed filesystem root") from error


def _run(
    arguments: Sequence[str],
    *,
    cwd: Path | str | None = None,
    runner=subprocess.run,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[str]:
    try:
        return runner(
            list(arguments),
            cwd=cwd,
            env=FIXED_ENV,
            text=True,
            capture_output=True,
            check=True,
            pass_fds=pass_fds,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError(f"provisioning command failed: {arguments[0]}") from error


def _git(repository: Path, *arguments: str) -> str:
    return _run(("/usr/bin/git", *arguments), cwd=repository).stdout


def _validate_directory(fd: int, label: str, uid: int, mode: int | None = None) -> None:
    details = os.fstat(fd)
    if not stat.S_ISDIR(details.st_mode):
        raise ValueError(f"{label} must be a real directory")
    if details.st_uid != uid:
        raise ValueError(f"{label} has unsafe ownership")
    observed = stat.S_IMODE(details.st_mode)
    if observed & 0o022:
        raise ValueError(f"{label} is group/world writable")
    if mode is not None and observed != mode:
        raise ValueError(f"{label} has unsafe mode; expected {mode:04o}")


def _open_root(path: Path, expected_uid: int) -> int:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("filesystem root must be a fixed absolute path")
    try:
        fd = os.open(path, _DIRECTORY_FLAGS)
    except OSError as error:
        raise ValueError("filesystem root is missing, unsafe, or symlinked") from error
    try:
        _validate_directory(fd, "filesystem root", expected_uid)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _ensure_directory(
    root_fd: int,
    parts: Sequence[str],
    mode: int,
    expected_uid: int,
) -> int:
    if not parts or any(not part or part in {".", ".."} or "/" in part for part in parts):
        raise ValueError("provisioning directory path is invalid")
    current = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            try:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
            except FileNotFoundError:
                create_mode = mode if final else 0o755
                os.mkdir(part, create_mode, dir_fd=current)
                os.fsync(current)
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
                os.fchmod(next_fd, create_mode)
            except OSError as error:
                raise ValueError("provisioning parent is unsafe or symlinked") from error
            try:
                _validate_directory(
                    next_fd,
                    f"provisioning parent {part}",
                    expected_uid,
                    mode if final else None,
                )
            except BaseException:
                os.close(next_fd)
                raise
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def _open_existing_directory(
    root_fd: int, parts: Sequence[str], expected_uid: int, mode: int
) -> int:
    current = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            try:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
            except OSError as error:
                raise ValueError("required provisioning directory is unsafe") from error
            _validate_directory(
                next_fd,
                f"provisioning directory {part}",
                expected_uid,
                mode if index == len(parts) - 1 else None,
            )
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def _exists(fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while provisioning")
        view = view[written:]


def _read_regular(
    parent_fd: int, name: str, mode: int, expected_uid: int, label: str
) -> bytes:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except OSError as error:
        raise ValueError(f"{label} is missing or unsafe") from error
    try:
        details = os.fstat(fd)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != expected_uid
            or stat.S_IMODE(details.st_mode) != mode
            or details.st_size > 1024 * 1024
        ):
            raise ValueError(f"{label} has unsafe ownership, mode, type, or size")
        content = bytearray()
        while len(content) < details.st_size:
            chunk = os.read(fd, details.st_size - len(content))
            if not chunk:
                raise ValueError(f"{label} changed while being read")
            content.extend(chunk)
        if os.read(fd, 1):
            raise ValueError(f"{label} changed while being read")
        return bytes(content)
    finally:
        os.close(fd)


def _publish_new(parent_fd: int, name: str, content: bytes, mode: int) -> None:
    if _exists(parent_fd, name):
        raise FileExistsError(f"provisioning destination already exists: {name}")
    temporary = f".{name}.{os.getpid()}.tmp"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
        dir_fd=parent_fd,
    )
    try:
        os.fchmod(descriptor, mode)
        _write_all(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.link(
            temporary,
            name,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        os.unlink(temporary, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        raise


def _replace_validated(
    parent_fd: int, name: str, content: bytes, mode: int, expected_uid: int
) -> None:
    existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        details = os.fstat(existing)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != expected_uid
            or stat.S_IMODE(details.st_mode) != mode
        ):
            raise ValueError(f"existing replacement destination is unsafe: {name}")
    finally:
        os.close(existing)
    temporary = f".{name}.{os.getpid()}.replacement"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
        dir_fd=parent_fd,
    )
    try:
        os.fchmod(descriptor, mode)
        _write_all(descriptor, content)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    os.fsync(parent_fd)


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


def _clone_authority(
    source: Path,
    authority: str,
    destination: Path,
    *,
    canonical: bool,
    pass_fds: tuple[int, ...] = (),
) -> None:
    clone_source = CANONICAL_REMOTE if canonical else str(source)
    previous_umask = os.umask(0o077)
    try:
        _run(
            (
                "/usr/bin/git",
                "clone",
                "--quiet",
                "--no-hardlinks",
                "--no-checkout",
                clone_source,
                str(destination),
            ),
            pass_fds=pass_fds,
        )
        if canonical:
            _git(destination, "fetch", "--quiet", "--no-tags", "--depth=1", "origin", authority)
        _git(destination, "checkout", "--quiet", "--detach", authority)
        if "github" in _git(destination, "remote").splitlines():
            _git(destination, "remote", "remove", "github")
        if "origin" in _git(destination, "remote").splitlines():
            _git(destination, "remote", "rename", "origin", "github")
        _git(destination, "remote", "set-url", "github", CANONICAL_REMOTE)
        if _git(destination, "status", "--porcelain=v1", "--untracked-files=all"):
            raise ValueError("installed authority checkout is not clean")
    finally:
        os.umask(previous_umask)


def _sha256(path: Path, label: str) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise RuntimeError(f"required evaluator file is unavailable: {label}") from error


def _build_evaluator(
    authority_root: Path,
    profile_json: dict[str, object],
    *,
    runner=subprocess.run,
    stop_after_install: bool = False,
    pass_fds: tuple[int, ...] = (),
) -> None:
    version = _run(
        ("/usr/bin/python3.14", "--version"), runner=runner, pass_fds=pass_fds
    ).stdout.strip()
    if version != "Python 3.14.4":
        raise RuntimeError(f"evaluator Python drift: {version}")
    bench = authority_root / "benchmarks/swebench"
    venv = bench / ".venv"
    if venv.exists() or venv.is_symlink():
        raise RuntimeError("authority evaluator destination already exists")
    _run(
        ("/usr/bin/python3.14", "-m", "venv", "--copies", str(venv)),
        runner=runner,
        pass_fds=pass_fds,
    )
    alias = venv / "lib64"
    if alias.is_symlink():
        alias.unlink()
    lock = bench / "requirements.lock"
    _run(
        (
            str(venv / "bin/python"),
            "-m",
            "pip",
            "install",
            "--require-hashes",
            "--only-binary=:all:",
            "--index-url",
            PYPI_INDEX,
            "-r",
            str(lock),
        ),
        runner=runner,
        pass_fds=pass_fds,
    )
    if stop_after_install:
        raise RuntimeError("fixture stops after command validation")
    evaluator = profile_json.get("evaluator")
    if not isinstance(evaluator, dict):
        raise RuntimeError("authority evaluator profile is invalid")
    expected_lock = evaluator.get("requirements_lock_sha256")
    if _sha256(lock, "requirements.lock") != expected_lock:
        raise RuntimeError("evaluator requirements lock SHA-256 mismatch")
    probe = (
        "import importlib.metadata as m,json;"
        "print(json.dumps(sorted((d.metadata['Name'],d.version) for d in m.distributions())))"
    )
    installed_result = _run(
        (str(venv / "bin/python"), "-I", "-E", "-s", "-c", probe),
        runner=runner,
        pass_fds=pass_fds,
    )
    try:
        installed_pairs = json.loads(installed_result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("evaluator distribution probe returned invalid JSON") from error
    installed = {re.sub(r"[-_.]+", "-", name).lower(): version for name, version in installed_pairs}
    expected = locked_distributions(lock)
    if installed != expected:
        raise RuntimeError("installed evaluator distributions do not equal requirements.lock")
    source = (
        venv
        / "lib/python3.14/site-packages/swebench/harness/run_evaluation.py"
    )
    if _sha256(source, "upstream run_evaluation.py") != evaluator.get(
        "upstream_run_evaluation_sha256"
    ):
        raise RuntimeError("upstream run_evaluation.py SHA-256 mismatch")
    patch = authority_root / str(evaluator.get("patch_path"))
    if _sha256(patch, "evaluator patch") != evaluator.get("patch_sha256"):
        raise RuntimeError("evaluator confinement patch SHA-256 mismatch")
    _run(
        (
            "/usr/bin/patch",
            "--batch",
            "--forward",
            "--fuzz=0",
            "--strip=1",
            "--input",
            str(patch),
        ),
        cwd=source.parents[2],
        runner=runner,
        pass_fds=pass_fds,
    )
    if _sha256(source, "patched run_evaluation.py") != evaluator.get(
        "patched_run_evaluation_sha256"
    ):
        raise RuntimeError("patched run_evaluation.py SHA-256 mismatch")


def _build_target_cache(
    authority_root: Path,
    profile_json: dict[str, object],
    *,
    runner=subprocess.run,
    pass_fds: tuple[int, ...] = (),
) -> None:
    dataset = profile_json.get("dataset")
    base_commit = dataset.get("base_commit") if isinstance(dataset, dict) else None
    if not isinstance(base_commit, str) or FULL_SHA.fullmatch(base_commit) is None:
        raise RuntimeError("authority target base commit is invalid")
    target = authority_root / "benchmarks/swebench/.cache/target.git"
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=False)
    _run(
        ("/usr/bin/git", "clone", "--quiet", "--no-checkout", TARGET_REMOTE, str(target)),
        runner=runner,
        pass_fds=pass_fds,
    )
    _run(
        (
            "/usr/bin/git",
            "-C",
            str(target),
            "fetch",
            "--quiet",
            "--no-tags",
            "--depth=1",
            "origin",
            base_commit,
        ),
        runner=runner,
        pass_fds=pass_fds,
    )
    _run(
        ("/usr/bin/git", "-C", str(target), "checkout", "--quiet", "--detach", base_commit),
        runner=runner,
        pass_fds=pass_fds,
    )
    observed = _run(
        ("/usr/bin/git", "-C", str(target), "rev-parse", "HEAD"),
        runner=runner,
        pass_fds=pass_fds,
    ).stdout.strip()
    if observed != base_commit:
        raise RuntimeError("trusted target checkout differs from the pinned base commit")


def _build_authority_environment(
    authority_root: Path,
    profile_json: dict[str, object],
    *,
    pass_fds: tuple[int, ...] = (),
) -> None:
    _build_evaluator(authority_root, profile_json, pass_fds=pass_fds)
    _build_target_cache(authority_root, profile_json, pass_fds=pass_fds)


def _load_apparmor(path: Path) -> None:
    _run(("/usr/sbin/apparmor_parser", "-r", str(path)))


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


def _generate_keys(state_fd: int, expected_uid: int) -> None:
    for name in ("gate-key.pem", "gate-key.pub.pem"):
        if _exists(state_fd, name):
            raise FileExistsError("gate key destination already exists")
    private_temp = f".gate-key.{os.getpid()}.pem"
    public_temp = f".gate-key.{os.getpid()}.pub.pem"
    cwd = f"/proc/self/fd/{state_fd}"
    _run(("/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", private_temp), cwd=cwd)
    _run(
        (
            "/usr/bin/openssl",
            "pkey",
            "-in",
            private_temp,
            "-pubout",
            "-out",
            public_temp,
        ),
        cwd=cwd,
    )
    private_fd = os.open(private_temp, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state_fd)
    public_fd = os.open(public_temp, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state_fd)
    try:
        os.fchmod(private_fd, 0o600)
        os.fchmod(public_fd, 0o644)
        if os.fstat(private_fd).st_uid != expected_uid or os.fstat(public_fd).st_uid != expected_uid:
            raise ValueError("generated gate key has unsafe ownership")
    finally:
        os.close(private_fd)
        os.close(public_fd)
    os.link(private_temp, "gate-key.pem", src_dir_fd=state_fd, dst_dir_fd=state_fd, follow_symlinks=False)
    os.link(public_temp, "gate-key.pub.pem", src_dir_fd=state_fd, dst_dir_fd=state_fd, follow_symlinks=False)
    os.unlink(private_temp, dir_fd=state_fd)
    os.unlink(public_temp, dir_fd=state_fd)
    os.fsync(state_fd)


def _provision(
    source: Path,
    authority: str,
    paths: ProvisionPaths = ProvisionPaths(),
    *,
    replace_authority: tuple[str, str] | None = None,
    owner_uid: int = 0,
    require_remote_tip: bool = True,
    apparmor_loader: Callable[[Path], None] = _load_apparmor,
    evaluator_builder: Callable[..., None] | None = None,
) -> dict[str, object]:
    _verify_source(source, authority, require_remote_tip)
    replacing = replace_authority is not None
    if replacing:
        old_authority, new_authority = replace_authority
        if authority != new_authority or old_authority == new_authority:
            raise ValueError("replacement authority arguments are inconsistent")

    root_fd = _open_root(paths.root, owner_uid)
    state_fd = config_parent_fd = launcher_parent_fd = -1
    staging_name = f".authority-{os.getpid()}"
    backup_name = f".authority-backup-{os.getpid()}"
    swapped = False
    published_launcher = False
    published_config = False
    previous_launcher: bytes | None = None
    previous_config: bytes | None = None
    try:
        state_fd = _ensure_directory(root_fd, paths.relative(paths.state), 0o700, owner_uid)
        config_parent_fd = _ensure_directory(
            root_fd, paths.relative(paths.config.parent), 0o755, owner_uid
        )
        launcher_parent_fd = _ensure_directory(
            root_fd, paths.relative(paths.launcher.parent), 0o755, owner_uid
        )
        for name in (staging_name, backup_name):
            if _exists(state_fd, name):
                raise FileExistsError("provisioning staging collision")
        authority_exists = _exists(state_fd, "authority")
        if replacing != authority_exists:
            message = (
                "SWE-bench gate is already provisioned; use --replace-authority"
                if authority_exists
                else "provisioned authority is missing for replacement"
            )
            raise FileExistsError(message)
        if replacing:
            previous_config = _read_regular(
                config_parent_fd,
                paths.config.name,
                0o600,
                owner_uid,
                "existing host config",
            )
            previous_launcher = _read_regular(
                launcher_parent_fd,
                paths.launcher.name,
                0o755,
                owner_uid,
                "existing host launcher",
            )
            try:
                existing_raw = json.loads(previous_config)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("existing host config is invalid") from error
            if (
                not isinstance(existing_raw, dict)
                or existing_raw.get("authority_commit") != old_authority
            ):
                raise ValueError("old authority does not match the provisioned authority")
        if not replacing and any(
            _exists(parent, name)
            for parent, name in (
                (config_parent_fd, paths.config.name),
                (launcher_parent_fd, paths.launcher.name),
                (state_fd, paths.private_key.name),
                (state_fd, paths.public_key.name),
            )
        ):
            raise FileExistsError("SWE-bench gate is already provisioned")
        os.mkdir(staging_name, 0o700, dir_fd=state_fd)
        os.fsync(state_fd)
        staging = Path(f"/proc/self/fd/{state_fd}/{staging_name}")
        staging.rmdir()
        _clone_authority(
            source.resolve(),
            authority,
            staging,
            canonical=require_remote_tip,
            pass_fds=(state_fd,),
        )
        staging.chmod(0o700)
        profile_path = staging / "benchmarks/swebench/profile.json"
        profile_json = json.loads(profile_path.read_text())
        if evaluator_builder is not None:
            evaluator_builder(staging, profile_json, pass_fds=(state_fd,))
        public_key_path = Path(f"/proc/self/fd/{state_fd}/{paths.public_key.name}")
        if not replacing:
            _generate_keys(state_fd, owner_uid)
        else:
            for name, mode in ((paths.private_key.name, 0o600), (paths.public_key.name, 0o644)):
                key_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state_fd)
                try:
                    details = os.fstat(key_fd)
                    if (
                        not stat.S_ISREG(details.st_mode)
                        or details.st_uid != owner_uid
                        or stat.S_IMODE(details.st_mode) != mode
                    ):
                        raise ValueError("existing gate key is unsafe")
                finally:
                    os.close(key_fd)
        candidate_config = _config(staging, authority, public_key_path)
        launcher_content = (staging / "benchmarks/swebench/host_launcher.py").read_bytes()
        if replacing:
            os.rename("authority", backup_name, src_dir_fd=state_fd, dst_dir_fd=state_fd)
        os.rename(staging_name, "authority", src_dir_fd=state_fd, dst_dir_fd=state_fd)
        os.fsync(state_fd)
        swapped = True
        apparmor_loader(
            paths.authority
            / "benchmarks/swebench/policies/alloy-swebench-gate.apparmor"
        )
        config_content = (
            json.dumps(candidate_config, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        if replacing:
            _replace_validated(
                launcher_parent_fd,
                paths.launcher.name,
                launcher_content,
                0o755,
                owner_uid,
            )
            published_launcher = True
            _replace_validated(
                config_parent_fd,
                paths.config.name,
                config_content,
                0o600,
                owner_uid,
            )
            published_config = True
            shutil.rmtree(f"/proc/self/fd/{state_fd}/{backup_name}")
            os.fsync(state_fd)
        else:
            _publish_new(launcher_parent_fd, paths.launcher.name, launcher_content, 0o755)
            published_launcher = True
            _publish_new(config_parent_fd, paths.config.name, config_content, 0o600)
            published_config = True
    except BaseException:
        if swapped and _exists(state_fd, backup_name):
            failed_name = f".authority-failed-{os.getpid()}"
            os.rename("authority", failed_name, src_dir_fd=state_fd, dst_dir_fd=state_fd)
            os.rename(backup_name, "authority", src_dir_fd=state_fd, dst_dir_fd=state_fd)
            shutil.rmtree(f"/proc/self/fd/{state_fd}/{failed_name}")
            os.fsync(state_fd)
        elif swapped and _exists(state_fd, "authority"):
            shutil.rmtree(f"/proc/self/fd/{state_fd}/authority")
            os.fsync(state_fd)
        if state_fd >= 0 and _exists(state_fd, staging_name):
            shutil.rmtree(f"/proc/self/fd/{state_fd}/{staging_name}")
        if not replacing and state_fd >= 0:
            for name in (paths.private_key.name, paths.public_key.name):
                try:
                    os.unlink(name, dir_fd=state_fd)
                except FileNotFoundError:
                    pass
            if published_config:
                os.unlink(paths.config.name, dir_fd=config_parent_fd)
                os.fsync(config_parent_fd)
            if published_launcher:
                os.unlink(paths.launcher.name, dir_fd=launcher_parent_fd)
                os.fsync(launcher_parent_fd)
        elif replacing:
            if previous_launcher is not None and published_launcher:
                _replace_validated(
                    launcher_parent_fd,
                    paths.launcher.name,
                    previous_launcher,
                    0o755,
                    owner_uid,
                )
            if previous_config is not None and published_config:
                _replace_validated(
                    config_parent_fd,
                    paths.config.name,
                    previous_config,
                    0o600,
                    owner_uid,
                )
        raise
    finally:
        for fd in (state_fd, config_parent_fd, launcher_parent_fd, root_fd):
            if fd >= 0:
                os.close(fd)

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
    try:
        receipt = _provision(
            SOURCE_ROOT,
            authority,
            replace_authority=replace_authority,
            evaluator_builder=_build_authority_environment,
        )
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
