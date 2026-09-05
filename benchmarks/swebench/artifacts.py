from __future__ import annotations

import json
import os
import stat
from pathlib import Path


_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
DEFAULT_MAX_FILE_BYTES = 16 * 1024**2
DEFAULT_MAX_TOTAL_BYTES = 256 * 1024**2


def _open_private_directory(path: Path, *, create: bool) -> int:
    absolute = path.is_absolute()
    current_fd = os.open("/" if absolute else ".", _DIRECTORY_FLAGS)
    parts = tuple(part for part in path.parts if part not in {path.anchor, "", "."})
    if not parts or any(part == ".." for part in parts):
        os.close(current_fd)
        raise ValueError("results directory must have a stable path")
    try:
        for index, part in enumerate(parts):
            if create and index == len(parts) - 1:
                try:
                    os.mkdir(part, 0o700, dir_fd=current_fd)
                    os.fsync(current_fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
    except OSError as error:
        os.close(current_fd)
        raise ValueError("results directory must not be a symlink and must have safe ancestors") from error
    details = os.fstat(current_fd)
    if stat.S_IMODE(details.st_mode) != 0o700:
        os.close(current_fd)
        raise ValueError("results directory must be mode 0700")
    if hasattr(os, "geteuid") and details.st_uid != os.geteuid():
        os.close(current_fd)
        raise ValueError("results directory must be owned by the current user")
    return current_fd


def _simple_name(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value in {".", ".."}
        or Path(value).name != value
        or "\0" in value
    ):
        raise ValueError(f"{label} must be a simple file name")
    return value


def _positive_limit(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be positive")
    return value


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while persisting result artifact")
        view = view[written:]


def _open_regular_nofollow(path: Path) -> int:
    absolute = path.is_absolute()
    current_fd = os.open("/" if absolute else ".", _DIRECTORY_FLAGS)
    parts = tuple(part for part in path.parts if part not in {path.anchor, "", "."})
    if not parts or any(part == ".." for part in parts):
        os.close(current_fd)
        raise ValueError("artifact source must have a stable path")
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        source_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current_fd)
    except OSError as error:
        raise ValueError("artifact source must be a regular file with no symlinked ancestors") from error
    finally:
        os.close(current_fd)
    if not stat.S_ISREG(os.fstat(source_fd).st_mode):
        os.close(source_fd)
        raise ValueError("artifact source must be a regular file")
    return source_fd


class ResultWriter:
    def __init__(
        self,
        results_root: Path,
        run_name: str,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    ) -> None:
        self._max_file_bytes = _positive_limit(max_file_bytes, "max_file_bytes")
        self._max_total_bytes = _positive_limit(max_total_bytes, "max_total_bytes")
        if self._max_file_bytes > self._max_total_bytes:
            raise ValueError("max_file_bytes must not exceed max_total_bytes")
        run_name = _simple_name(run_name, "run name")
        root_fd = _open_private_directory(results_root, create=True)
        try:
            try:
                os.mkdir(run_name, 0o700, dir_fd=root_fd)
            except FileExistsError as error:
                raise FileExistsError("result run already exists") from error
            os.fsync(root_fd)
            self._run_fd = os.open(run_name, _DIRECTORY_FLAGS, dir_fd=root_fd)
        finally:
            os.close(root_fd)
        self.run_dir = Path(os.path.abspath(results_root)) / run_name
        self._total_bytes = 0
        self._failed = False

    def close(self) -> None:
        run_fd = getattr(self, "_run_fd", -1)
        if run_fd >= 0:
            os.close(run_fd)
            self._run_fd = -1

    def __enter__(self) -> ResultWriter:
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()

    def _check_size(self, size: int) -> None:
        if size > self._max_file_bytes:
            raise ValueError("artifact exceeds the file size limit")
        if self._total_bytes + size > self._max_total_bytes:
            raise ValueError("artifact exceeds the total size limit")

    def _write(self, name: str, content: bytes) -> Path:
        if self._run_fd < 0 or self._failed:
            raise ValueError("result writer is closed")
        name = _simple_name(name, "artifact name")
        self._check_size(len(content))
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=self._run_fd,
        )
        try:
            try:
                _write_all(fd, content)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(self._run_fd)
        except BaseException:
            self._failed = True
            raise
        self._total_bytes += len(content)
        return self.run_dir / name

    def write_json(self, name: str, value: object) -> Path:
        content = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        return self._write(name, content)

    def write_text(self, name: str, content: str) -> Path:
        if not isinstance(content, str):
            raise ValueError("artifact text must be a string")
        return self._write(name, content.encode("utf-8"))

    def copy_regular_file(self, name: str, source: Path) -> Path:
        source_fd = _open_regular_nofollow(source)
        try:
            details = os.fstat(source_fd)
            self._check_size(details.st_size)
            chunks = []
            remaining = details.st_size
            while remaining:
                chunk = os.read(source_fd, min(remaining, 1024 * 1024))
                if not chunk:
                    raise ValueError("artifact source changed while being copied")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(source_fd, 1):
                raise ValueError("artifact source changed while being copied")
        finally:
            os.close(source_fd)
        return self._write(name, b"".join(chunks))
