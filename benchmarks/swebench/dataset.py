from __future__ import annotations

import hashlib
import json
import math
import os
import stat
import tempfile
import urllib.request
from pathlib import Path

from benchmarks.swebench.profile import BenchmarkProfile


PRIVATE_FIELDS = frozenset({"patch", "test_patch"})


def _validate_json(value: object) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical JSON does not permit non-finite numbers")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json(item)
        return
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("canonical JSON object keys must be strings")
        for item in value.values():
            _validate_json(item)
        return
    raise TypeError(f"canonical JSON does not permit {type(value).__name__}")


def canonical_json_bytes(value: object) -> bytes:
    _validate_json(value)
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def dataset_url(profile: BenchmarkProfile) -> str:
    pin = profile.dataset
    return (
        f"https://huggingface.co/datasets/{pin.name}/resolve/"
        f"{pin.revision}/{pin.parquet_path}"
    )


def _open_url(url: str):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(url, timeout=120)


def _digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _verified_parquet(cache: Path, profile: BenchmarkProfile) -> Path:
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    if cache.is_symlink() or not cache.is_dir():
        raise RuntimeError("dataset cache must be a real directory")
    destination = cache / f"{profile.dataset.parquet_sha256}.parquet"
    if destination.exists():
        metadata = destination.lstat()
        if not stat.S_ISREG(metadata.st_mode) or destination.is_symlink():
            raise RuntimeError("cached dataset parquet must be a regular file")
        if _digest_file(destination) != profile.dataset.parquet_sha256:
            raise RuntimeError("cached dataset parquet SHA-256 mismatch")
        return destination

    descriptor, temporary_name = tempfile.mkstemp(prefix=".dataset-", dir=cache)
    temporary = Path(temporary_name)
    try:
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "wb") as output, _open_url(dataset_url(profile)) as response:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != profile.dataset.parquet_sha256:
            raise RuntimeError("downloaded dataset parquet SHA-256 mismatch")
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        directory_fd = os.open(cache, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return destination
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _read_instance(path: Path, instance_id: str) -> dict[str, object]:
    try:
        import pyarrow.parquet as parquet
    except ImportError as error:
        raise RuntimeError("the verified evaluator environment must provide pyarrow") from error
    rows = parquet.read_table(path).to_pylist()
    matches = [row for row in rows if row.get("instance_id") == instance_id]
    if len(matches) != 1 or not isinstance(matches[0], dict):
        raise RuntimeError(f"expected one dataset row for {instance_id}, found {len(matches)}")
    return matches[0]


def fetch_and_verify_instance(cache: Path, profile: BenchmarkProfile) -> dict:
    row = _read_instance(_verified_parquet(cache, profile), profile.instance_id)
    if row.get("base_commit") != profile.base_commit:
        raise RuntimeError(f"dataset base commit drift for {profile.instance_id}")
    encoded = canonical_json_bytes(row)
    if len(encoded) != 7104:
        raise RuntimeError(f"dataset row size drift: expected 7104, observed {len(encoded)}")
    if hashlib.sha256(encoded).hexdigest() != profile.dataset.row_sha256:
        raise RuntimeError("dataset row SHA-256 mismatch")
    return row


def prompt_instance(row: dict) -> dict:
    return {key: value for key, value in row.items() if key not in PRIVATE_FIELDS}


def write_private_dataset_json(path: Path, row: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical_json_bytes([row]) + b"\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
