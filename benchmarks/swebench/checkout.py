from __future__ import annotations

import hashlib
import os
import selectors
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import BinaryIO


GIT = "/usr/bin/git"
try:
    NOFOLLOW = os.O_NOFOLLOW
    DIRECTORY = os.O_DIRECTORY
except AttributeError as error:
    raise RuntimeError("trusted checkout reconstruction requires O_NOFOLLOW and O_DIRECTORY") from error
MAX_PATH_BYTES = 4096
MAX_PATH_COMPONENTS = 128
MAX_COMPONENT_BYTES = 255
MAX_TAR_READ = 1024 * 1024
FIXED_GIT_ENV = MappingProxyType(
    {
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/bin:/bin",
    }
)
GIT_SECURITY_OPTIONS = ("-c", "core.hooksPath=/dev/null", "-c", "diff.external=")
PATCH_EXPANSION_FACTOR = 3
PATCH_FILE_OVERHEAD = 8192
PATCH_FIXED_OVERHEAD = 1024 * 1024


@dataclass(frozen=True)
class ExportBounds:
    max_files: int = 20_000
    max_file_bytes: int = 16 * 1024**2
    max_total_bytes: int = 256 * 1024**2

    def __post_init__(self) -> None:
        values = (self.max_files, self.max_file_bytes, self.max_total_bytes)
        if any(type(value) is not int or value <= 0 for value in values):
            raise ValueError("export bounds must be positive integers")
        if self.max_file_bytes > self.max_total_bytes:
            raise ValueError("max_file_bytes must not exceed max_total_bytes")


@dataclass(frozen=True)
class _TreeEntry:
    path: PurePosixPath
    kind: str
    mode: int
    linkname: str | None = None
    size: int = 0
    digest: str = ""
    device: int = 0
    inode: int = 0


@dataclass(frozen=True)
class _ScannedEntry:
    path: PurePosixPath
    kind: str
    mode: int
    linkname: str | None
    size: int
    implicit: bool = False


class _TreeOwner:
    def __init__(self, temporary: tempfile.TemporaryDirectory[str], root_fd: int) -> None:
        self.temporary = temporary
        self.root_fd = root_fd
        self.consumed = False

    def consume(self) -> int:
        if self.consumed or self.root_fd < 0:
            raise ValueError("validated export has already been consumed")
        self.consumed = True
        return os.dup(self.root_fd)

    def close(self) -> None:
        if self.root_fd >= 0:
            os.close(self.root_fd)
            self.root_fd = -1
        self.temporary.cleanup()


@dataclass(frozen=True)
class ValidatedTree:
    entries: tuple[_TreeEntry, ...]
    file_count: int
    total_bytes: int
    bounds: ExportBounds
    _owner: _TreeOwner

    def close(self) -> None:
        self._owner.close()

    def __enter__(self) -> ValidatedTree:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


class _CapturedPatch:
    def __init__(self, output: BinaryIO, size: int) -> None:
        self.output = output
        self.size = size

    def read(self) -> bytes:
        try:
            self.output.seek(0)
            data = self.output.read(self.size + 1)
            if len(data) != self.size:
                raise RuntimeError("captured patch storage changed size")
            return data
        finally:
            self.close()

    def close(self) -> None:
        self.output.close()


_CAPTURED_PATCHES: dict[tuple[int, int, str], _CapturedPatch] = {}


def _normalized_path(name: str) -> PurePosixPath:
    if not isinstance(name, str) or not name or "\0" in name:
        raise ValueError("archive member path is invalid")
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or path in (PurePosixPath("."),):
        raise ValueError(f"archive member path is not a normalized relative path: {name!r}")
    if any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"archive member path is not a normalized relative path: {name!r}")
    encoded_parts = [os.fsencode(part) for part in path.parts]
    if len(os.fsencode(name)) > MAX_PATH_BYTES or any(
        len(part) > MAX_COMPONENT_BYTES for part in encoded_parts
    ):
        raise ValueError("archive member path exceeds the length bound")
    if len(path.parts) > MAX_PATH_COMPONENTS:
        raise ValueError("archive member path exceeds the depth bound")
    if ".git" in path.parts:
        raise ValueError("archive contains forbidden Git metadata")
    return path


def _safe_symlink_target(path: PurePosixPath, target: str) -> str:
    if not isinstance(target, str) or not target or "\0" in target:
        raise ValueError("archive symlink target is invalid")
    link = PurePosixPath(target)
    if link.is_absolute():
        raise ValueError(f"archive symlink {path.as_posix()!r} target must be relative")
    encoded_parts = [os.fsencode(part) for part in link.parts]
    if len(os.fsencode(target)) > MAX_PATH_BYTES or any(
        len(part) > MAX_COMPONENT_BYTES for part in encoded_parts
    ):
        raise ValueError("archive symlink target exceeds the length bound")
    if len(link.parts) > MAX_PATH_COMPONENTS:
        raise ValueError("archive symlink target exceeds the depth bound")
    resolved = list(path.parent.parts)
    for part in link.parts:
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise ValueError("archive symlink escapes the exported tree")
            resolved.pop()
        else:
            resolved.append(part)
    if ".git" in resolved:
        raise ValueError("archive symlink targets forbidden Git metadata")
    return target


def _validate_symlink_graph(
    entries: dict[PurePosixPath, _TreeEntry | _ScannedEntry],
) -> None:
    links = {
        path: PurePosixPath(entry.linkname or "")
        for path, entry in entries.items()
        if entry.kind == "symlink"
    }
    for path, target in links.items():
        remaining = list(target.parts)
        resolved = list(path.parent.parts)
        followed: set[PurePosixPath] = set()
        steps = 0
        while remaining:
            steps += 1
            if steps > MAX_PATH_COMPONENTS * 2:
                raise ValueError("archive symlink chain exceeds the depth bound")
            part = remaining.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not resolved:
                    raise ValueError("archive symlink chain escapes the exported tree")
                resolved.pop()
                continue
            resolved.append(part)
            if len(resolved) > MAX_PATH_COMPONENTS:
                raise ValueError("archive symlink chain exceeds the depth bound")
            candidate = PurePosixPath(*resolved)
            linked = links.get(candidate)
            if linked is None:
                continue
            if candidate in followed:
                raise ValueError("archive symlink chain contains a cycle")
            followed.add(candidate)
            resolved.pop()
            remaining = [*linked.parts, *remaining]
        if ".git" in resolved:
            raise ValueError("archive symlink chain targets forbidden Git metadata")


def _member_kind(member: tarfile.TarInfo) -> str:
    if member.isreg():
        return "file"
    if member.isdir():
        return "directory"
    if member.issym():
        return "symlink"
    if member.islnk():
        raise ValueError("archive hard links are forbidden")
    forbidden_type = (
        "fifo" if member.isfifo()
        else "character-device" if member.ischr()
        else "block-device" if member.isblk()
        else "unknown"
    )
    raise ValueError(
        f"archive member {member.name!r} has forbidden type {forbidden_type}"
    )


def _validate_owner(member: tarfile.TarInfo) -> None:
    if member.uid not in (0, 65532) or member.gid not in (0, 65532):
        raise ValueError("archive member ownership is forbidden")


def _normalized_mode(member: tarfile.TarInfo, kind: str) -> int:
    mode = member.mode
    if type(mode) is not int or mode < 0 or mode & ~0o777:
        raise ValueError("archive member mode is forbidden")
    if kind == "directory":
        return 0o755
    if kind == "symlink":
        return 0o777
    return 0o755 if mode & 0o111 else 0o644


def _open_directory(root_fd: int, parts: tuple[str, ...], *, create: bool) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
            metadata = os.fstat(child)
            if not stat.S_ISDIR(metadata.st_mode):
                os.close(child)
                raise ValueError("archive path conflicts with a non-directory")
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def _write_regular(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    root_fd: int,
    path: PurePosixPath,
    mode: int,
    bounds: ExportBounds,
    total_bytes: int,
) -> tuple[int, str]:
    if member.size < 0 or member.size > bounds.max_file_bytes:
        raise ValueError("archive member exceeds the per-file byte bound")
    if total_bytes + member.size > bounds.max_total_bytes:
        raise ValueError("archive exceeds the total byte bound")
    source = archive.extractfile(member)
    if source is None:
        raise ValueError("archive regular file has no content")
    parent = _open_directory(root_fd, path.parent.parts, create=True)
    descriptor = -1
    written = 0
    digest = hashlib.sha256()
    try:
        descriptor = os.open(
            path.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
            dir_fd=parent,
        )
        while written < member.size:
            chunk = source.read(min(1024 * 1024, member.size - written))
            if not chunk:
                raise ValueError("archive regular file ended before its declared size")
            view = memoryview(chunk)
            while view:
                count = os.write(descriptor, view)
                view = view[count:]
            written += len(chunk)
            digest.update(chunk)
        os.fchmod(descriptor, mode)
    finally:
        source.close()
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent)
    return total_bytes + written, digest.hexdigest()


def _create_directory(root_fd: int, path: PurePosixPath, mode: int) -> None:
    parent = _open_directory(root_fd, path.parent.parts, create=True)
    descriptor = -1
    try:
        try:
            os.mkdir(path.name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        descriptor = os.open(path.name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent)
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ValueError("archive directory conflicts with another member")
        os.fchmod(descriptor, mode)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent)


def _create_symlink(root_fd: int, path: PurePosixPath, target: str) -> None:
    parent = _open_directory(root_fd, path.parent.parts, create=True)
    try:
        os.symlink(target, path.name, dir_fd=parent)
    finally:
        os.close(parent)


class _BoundedTarReader:
    def __init__(self, source: object) -> None:
        self.source = source

    def read(self, size: int = -1) -> bytes:
        if size < 0 or size > MAX_TAR_READ:
            raise ValueError("tar metadata read exceeds the memory bound")
        return self.source.read(size)  # type: ignore[no-any-return, union-attr]

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return self.source.seek(offset, whence)  # type: ignore[no-any-return, union-attr]

    def tell(self) -> int:
        return self.source.tell()  # type: ignore[no-any-return, union-attr]


def _archive_limit(bounds: ExportBounds) -> int:
    archive_overhead = bounds.max_files * (
        2 * tarfile.BLOCKSIZE + MAX_PATH_BYTES + tarfile.BLOCKSIZE
    ) + tarfile.RECORDSIZE
    return bounds.max_total_bytes + archive_overhead


def _snapshot_archive(path: Path, bounds: ExportBounds) -> BinaryIO:
    try:
        source_fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    except OSError as error:
        raise ValueError("exported tar is malformed or unsafe") from error
    snapshot = tempfile.TemporaryFile()
    copied = 0
    try:
        if not stat.S_ISREG(os.fstat(source_fd).st_mode):
            raise ValueError("export must be a regular tar file")
        limit = _archive_limit(bounds)
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > limit:
                raise ValueError("tar file exceeds the archive byte bound")
            view = memoryview(chunk)
            while view:
                written = snapshot.write(view)
                if written is None or written <= 0:
                    raise OSError("could not snapshot exported tar")
                view = view[written:]
        snapshot.flush()
        snapshot.seek(0)
        return snapshot
    except BaseException:
        snapshot.close()
        raise
    finally:
        os.close(source_fd)


def _open_archive(snapshot: BinaryIO) -> tarfile.TarFile:
    snapshot.seek(0)
    return tarfile.open(fileobj=_BoundedTarReader(snapshot), mode="r:")


def _scan_archive(snapshot: BinaryIO, bounds: ExportBounds) -> tuple[tuple[_ScannedEntry, ...], int]:
    entries: dict[PurePosixPath, _ScannedEntry] = {}
    explicit_order: list[PurePosixPath] = []
    implicit_directories: set[PurePosixPath] = set()
    total_bytes = 0
    try:
        with _open_archive(snapshot) as archive:
            for member in archive:
                path_value = _normalized_path(member.name)
                if path_value in entries:
                    raise ValueError("archive contains duplicate member names")
                kind = _member_kind(member)
                _validate_owner(member)
                mode = _normalized_mode(member, kind)
                size = member.size if kind == "file" else 0
                if size < 0 or size > bounds.max_file_bytes:
                    raise ValueError("archive member exceeds the per-file byte bound")
                if total_bytes + size > bounds.max_total_bytes:
                    raise ValueError("archive exceeds the total byte bound")
                total_bytes += size
                ancestors = tuple(path_value.parents)[:-1]
                for ancestor in ancestors:
                    existing = entries.get(ancestor)
                    if existing is not None and existing.kind != "directory":
                        raise ValueError("archive member path has a parent type conflict")
                    if existing is None and ancestor not in implicit_directories:
                        if len(entries) + len(implicit_directories) >= bounds.max_files:
                            raise ValueError("archive exceeds the file count bound")
                        implicit_directories.add(ancestor)
                if path_value not in implicit_directories:
                    if len(entries) + len(implicit_directories) >= bounds.max_files:
                        raise ValueError("archive exceeds the file count bound")
                if path_value in implicit_directories and kind != "directory":
                    raise ValueError("archive member path has an implicit directory conflict")
                linkname = (
                    _safe_symlink_target(path_value, member.linkname)
                    if kind == "symlink"
                    else None
                )
                if kind == "directory":
                    implicit_directories.discard(path_value)
                entries[path_value] = _ScannedEntry(
                    path_value, kind, mode, linkname, size
                )
                explicit_order.append(path_value)
        _validate_symlink_graph(entries)
    except (tarfile.TarError, OSError) as error:
        raise ValueError("exported tar is malformed or unsafe") from error
    implicit_entries = tuple(
        _ScannedEntry(path, "directory", 0o755, None, 0, True)
        for path in sorted(
            implicit_directories - entries.keys(),
            key=lambda value: (len(value.parts), value.parts),
        )
    )
    return (
        *implicit_entries,
        *(entries[path] for path in explicit_order),
    ), total_bytes


def _entry_metadata(root_fd: int, scanned: _ScannedEntry, digest: str = "") -> _TreeEntry:
    parent = _open_directory(root_fd, scanned.path.parent.parts, create=False)
    try:
        metadata = os.stat(scanned.path.name, dir_fd=parent, follow_symlinks=False)
    finally:
        os.close(parent)
    return _TreeEntry(
        scanned.path,
        scanned.kind,
        scanned.mode,
        scanned.linkname,
        scanned.size,
        digest,
        metadata.st_dev,
        metadata.st_ino,
    )


def _extract_archive(
    snapshot: BinaryIO,
    scanned_entries: tuple[_ScannedEntry, ...],
    bounds: ExportBounds,
    root_fd: int,
) -> tuple[_TreeEntry, ...]:
    explicit = [entry for entry in scanned_entries if not entry.implicit]
    digests: dict[PurePosixPath, str] = {}
    total_bytes = 0
    try:
        with _open_archive(snapshot) as archive:
            for member, expected in zip(archive, explicit, strict=True):
                observed = _normalized_path(member.name)
                kind = _member_kind(member)
                mode = _normalized_mode(member, kind)
                if (
                    observed != expected.path
                    or kind != expected.kind
                    or mode != expected.mode
                    or member.size != expected.size
                    or (kind == "symlink" and member.linkname != expected.linkname)
                ):
                    raise RuntimeError("owned tar snapshot changed after validation")
                if kind == "symlink":
                    assert expected.linkname is not None
                    _create_symlink(root_fd, expected.path, expected.linkname)
                elif kind == "directory":
                    _create_directory(root_fd, expected.path, expected.mode)
                else:
                    total_bytes, digest = _write_regular(
                        archive,
                        member,
                        root_fd,
                        expected.path,
                        expected.mode,
                        bounds,
                        total_bytes,
                    )
                    digests[expected.path] = digest
    except (tarfile.TarError, OSError) as error:
        raise ValueError("exported tar is malformed or unsafe") from error
    for entry in scanned_entries:
        if entry.implicit:
            _create_directory(root_fd, entry.path, entry.mode)
    return tuple(
        _entry_metadata(root_fd, entry, digests.get(entry.path, ""))
        for entry in scanned_entries
    )


def validate_exported_tar(path: Path, bounds: ExportBounds) -> ValidatedTree:
    snapshot = _snapshot_archive(path, bounds)
    temporary = tempfile.TemporaryDirectory(prefix="alloy-swebench-export-")
    root = Path(temporary.name)
    root_fd = -1
    try:
        scanned_entries, total_bytes = _scan_archive(snapshot, bounds)
        root_fd = os.open(root, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        validated_entries = _extract_archive(snapshot, scanned_entries, bounds, root_fd)
        owner = _TreeOwner(temporary, root_fd)
        root_fd = -1
        return ValidatedTree(
            validated_entries,
            len(validated_entries),
            total_bytes,
            bounds,
            owner,
        )
    except BaseException:
        temporary.cleanup()
        raise
    finally:
        snapshot.close()
        if root_fd >= 0:
            os.close(root_fd)


def _git(
    checkout: Path,
    arguments: tuple[str, ...],
    *,
    accepted_returncodes: frozenset[int] = frozenset({0}),
    input: bytes | None = None,
    timeout: int = 120,
) -> bytes:
    try:
        result = subprocess.run(
            [GIT, *GIT_SECURITY_OPTIONS, *arguments],
            cwd=checkout,
            input=input,
            capture_output=True,
            env=FIXED_GIT_ENV,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("trusted Git command timed out") from error
    if result.returncode not in accepted_returncodes:
        detail = result.stderr.decode("utf-8", errors="replace")[:4096].strip()
        message = f"trusted Git command failed with exit {result.returncode}"
        raise RuntimeError(f"{message}: {detail}" if detail else message)
    return result.stdout


def _remove_at(parent_fd: int, name: str) -> None:
    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
    try:
        for entry in os.listdir(child):
            _remove_at(child, entry)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=parent_fd)


def _copy_regular(
    source_root: int,
    destination_root: int,
    entry: _TreeEntry,
    bounds: ExportBounds,
    total_bytes: int,
) -> int:
    source_parent = _open_directory(source_root, entry.path.parent.parts, create=False)
    destination_parent = _open_directory(destination_root, entry.path.parent.parts, create=True)
    source = destination = -1
    copied = 0
    digest = hashlib.sha256()
    try:
        source = os.open(entry.path.name, os.O_RDONLY | NOFOLLOW, dir_fd=source_parent)
        before = os.fstat(source)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_dev != entry.device
            or before.st_ino != entry.inode
            or before.st_size != entry.size
        ):
            raise RuntimeError("validated export staging file changed identity or size")
        if entry.size > bounds.max_file_bytes or total_bytes + entry.size > bounds.max_total_bytes:
            raise RuntimeError("validated export exceeds copy byte bounds")
        destination = os.open(
            entry.path.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
            dir_fd=destination_parent,
        )
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > entry.size or total_bytes + copied > bounds.max_total_bytes:
                raise RuntimeError("validated export changed size while copying")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                count = os.write(destination, view)
                view = view[count:]
        after = os.fstat(source)
        if (
            copied != entry.size
            or after.st_dev != before.st_dev
            or after.st_ino != before.st_ino
            or after.st_size != before.st_size
            or digest.hexdigest() != entry.digest
        ):
            raise RuntimeError("validated export staging file changed size or digest")
        os.fchmod(destination, entry.mode)
    finally:
        if source >= 0:
            os.close(source)
        if destination >= 0:
            os.close(destination)
        os.close(source_parent)
        os.close(destination_parent)
    return total_bytes + copied


def _verify_nonregular(source_root: int, entry: _TreeEntry) -> None:
    parent = _open_directory(source_root, entry.path.parent.parts, create=False)
    try:
        metadata = os.stat(entry.path.name, dir_fd=parent, follow_symlinks=False)
        if metadata.st_dev != entry.device or metadata.st_ino != entry.inode:
            raise RuntimeError("validated export staging entry changed identity")
        if entry.kind == "directory" and not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError("validated export staging directory changed type")
        if entry.kind == "symlink":
            if not stat.S_ISLNK(metadata.st_mode):
                raise RuntimeError("validated export staging symlink changed type")
            if os.readlink(entry.path.name, dir_fd=parent) != entry.linkname:
                raise RuntimeError("validated export staging symlink changed target")
    finally:
        os.close(parent)


def _inventory_paths(root_fd: int) -> set[PurePosixPath]:
    paths: set[PurePosixPath] = set()

    def walk(directory_fd: int, prefix: PurePosixPath) -> None:
        for name in os.listdir(directory_fd):
            path = prefix / name
            metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            paths.add(path)
            if stat.S_ISDIR(metadata.st_mode):
                child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory_fd)
                try:
                    walk(child, path)
                finally:
                    os.close(child)

    walk(root_fd, PurePosixPath())
    return paths


def _patch_limit(bounds: ExportBounds) -> int:
    return (
        bounds.max_total_bytes * PATCH_EXPANSION_FACTOR
        + bounds.max_files * PATCH_FILE_OVERHEAD
        + PATCH_FIXED_OVERHEAD
    )


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def _bounded_git_diff(checkout: Path, maximum_bytes: int) -> _CapturedPatch:
    output = tempfile.TemporaryFile()
    try:
        process = subprocess.Popen(
            [
                GIT,
                *GIT_SECURITY_OPTIONS,
                "diff",
                "--cached",
                "--binary",
                "--no-ext-diff",
                "HEAD",
                "--",
            ],
            cwd=checkout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=FIXED_GIT_ENV,
            start_new_session=True,
        )
    except BaseException:
        output.close()
        raise
    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    size = 0
    stderr = bytearray()
    deadline = time.monotonic() + 120
    try:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate_process(process)
                raise RuntimeError("trusted Git diff timed out")
            events = selector.select(min(remaining, 1.0))
            for key, _mask in events:
                chunk = os.read(key.fd, 1024 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == "stdout":
                    size += len(chunk)
                    if size > maximum_bytes:
                        _terminate_process(process)
                        raise RuntimeError("patch output exceeds the configured bound")
                    view = memoryview(chunk)
                    while view:
                        written = output.write(view)
                        if written is None or written <= 0:
                            raise OSError("could not persist bounded patch output")
                        view = view[written:]
                elif len(stderr) < 4096:
                    stderr.extend(chunk[: 4096 - len(stderr)])
        returncode = process.wait()
        if returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()
            message = f"trusted Git diff failed with exit {returncode}"
            raise RuntimeError(f"{message}: {detail}" if detail else message)
        output.flush()
        output.seek(0)
        return _CapturedPatch(output, size)
    except BaseException:
        if process.poll() is None:
            _terminate_process(process)
        output.close()
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def reconstruct_trusted_checkout(base: Path, exported: ValidatedTree, destination: Path) -> None:
    if destination.exists() or destination.is_symlink():
        raise ValueError("trusted checkout destination must not exist")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_fd = exported._owner.consume()
    captured: _CapturedPatch | None = None
    try:
        _git(
            destination.parent,
            (
                "clone",
                "--quiet",
                "--no-hardlinks",
                "--no-local",
                "--no-checkout",
                "--",
                str(base.resolve()),
                str(destination),
            ),
            timeout=900,
        )
        os.chmod(destination, 0o700)
        _git(destination, ("checkout", "--quiet", "--detach", "HEAD"))
        destination_fd = os.open(destination, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        try:
            expected_paths = {entry.path for entry in exported.entries}
            if _inventory_paths(source_fd) != expected_paths:
                raise RuntimeError("validated export staging inventory changed")
            for name in os.listdir(destination_fd):
                if name != ".git":
                    _remove_at(destination_fd, name)
            copied_bytes = 0
            for entry in exported.entries:
                if entry.kind == "directory":
                    _verify_nonregular(source_fd, entry)
                    _create_directory(destination_fd, entry.path, entry.mode)
                elif entry.kind == "symlink":
                    _verify_nonregular(source_fd, entry)
                    assert entry.linkname is not None
                    _create_symlink(destination_fd, entry.path, entry.linkname)
                else:
                    copied_bytes = _copy_regular(
                        source_fd,
                        destination_fd,
                        entry,
                        exported.bounds,
                        copied_bytes,
                    )
            if copied_bytes != exported.total_bytes:
                raise RuntimeError("validated export copy total changed")
        finally:
            os.close(destination_fd)
        git_fd, info_fd = _force_binary_attributes(destination)
        try:
            _git(destination, ("add", "-A", "-f", "--", "."))
            captured = _bounded_git_diff(destination, _patch_limit(exported.bounds))
        finally:
            os.unlink("attributes", dir_fd=info_fd)
            os.close(info_fd)
            os.close(git_fd)
        os.chmod(destination, 0o755)
        metadata = os.stat(destination, follow_symlinks=False)
        identity = (metadata.st_dev, metadata.st_ino, str(destination.resolve()))
        previous = _CAPTURED_PATCHES.pop(identity, None)
        if previous is not None:
            previous.close()
        assert captured is not None
        _CAPTURED_PATCHES[identity] = captured
        captured = None
    except BaseException:
        if captured is not None:
            captured.close()
        shutil.rmtree(destination, ignore_errors=True)
        raise
    finally:
        os.close(source_fd)
        exported.close()


def _force_binary_attributes(checkout: Path) -> tuple[int, int]:
    git_fd = os.open(checkout / ".git", os.O_RDONLY | DIRECTORY | NOFOLLOW)
    info_fd = _open_directory(git_fd, ("info",), create=True)
    attributes_fd = -1
    try:
        attributes_fd = os.open(
            "attributes",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
            dir_fd=info_fd,
        )
        content = memoryview(
            b"* binary -text -filter -ident -working-tree-encoding\n"
        )
        while content:
            content = content[os.write(attributes_fd, content):]
        os.fsync(attributes_fd)
        return git_fd, info_fd
    except BaseException:
        os.close(info_fd)
        os.close(git_fd)
        raise
    finally:
        if attributes_fd >= 0:
            os.close(attributes_fd)


def capture_patch(checkout: Path) -> bytes:
    metadata = os.stat(checkout, follow_symlinks=False)
    identity = (metadata.st_dev, metadata.st_ino, str(checkout.resolve()))
    captured = _CAPTURED_PATCHES.pop(identity, None)
    if captured is None:
        raise ValueError("patch capture requires a freshly reconstructed trusted checkout")
    return captured.read()
