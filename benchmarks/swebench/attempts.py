from __future__ import annotations

import base64
import binascii
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path


GIT_SHA = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class ConsumptionUncertainError(RuntimeError):
    pass


def _nonempty(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _digest(value: object, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError(f"{label} has an invalid digest")
    return value


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _open_regular_nofollow(path: Path, label: str) -> int:
    absolute = path.is_absolute()
    current_fd = os.open("/" if absolute else ".", _DIRECTORY_FLAGS)
    parts = tuple(part for part in path.parts if part not in {path.anchor, "", "."})
    if not parts or any(part == ".." for part in parts):
        os.close(current_fd)
        raise ValueError(f"{label} must have a stable path")
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current_fd)
    except OSError as error:
        raise ValueError(f"{label} must be a regular file with no symlinked ancestors") from error
    finally:
        os.close(current_fd)
    if not stat.S_ISREG(os.fstat(file_fd).st_mode):
        os.close(file_fd)
        raise ValueError(f"{label} must be a regular file")
    return file_fd


def _descriptor_path(fd: int) -> str:
    return f"/proc/self/fd/{fd}"


def _sealed_memfd(name: str, content: bytes) -> int:
    try:
        required = (
            fcntl.F_SEAL_WRITE
            | fcntl.F_SEAL_GROW
            | fcntl.F_SEAL_SHRINK
            | fcntl.F_SEAL_SEAL
        )
        flags = os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
        fd = os.memfd_create(name, flags)
    except (AttributeError, OSError) as error:
        raise ValueError("sealed memfd support is required for gate cryptography") from error
    try:
        _write_all(fd, content)
        os.lseek(fd, 0, os.SEEK_SET)
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, required)
        if fcntl.fcntl(fd, fcntl.F_GET_SEALS) & required != required:
            raise ValueError("gate cryptography memfd did not retain all required seals")
    except (AttributeError, OSError, ValueError) as error:
        os.close(fd)
        raise ValueError("sealed memfd creation failed for gate cryptography") from error
    return fd


@dataclass(frozen=True)
class AttemptKey:
    candidate_commit: str
    instance_id: str
    dataset_revision: str
    row_sha256: str
    model_digest: str
    authority_profile_digest: str

    def __post_init__(self) -> None:
        _digest(self.candidate_commit, "candidate_commit", GIT_SHA)
        _nonempty(self.instance_id, "instance_id")
        _digest(self.dataset_revision, "dataset_revision", GIT_SHA)
        _digest(self.row_sha256, "row_sha256", SHA256)
        _digest(self.model_digest, "model_digest", SHA256)
        _digest(self.authority_profile_digest, "authority_profile_digest", SHA256)

    def as_dict(self) -> dict[str, str]:
        return {
            "authority_profile_digest": self.authority_profile_digest,
            "candidate_commit": self.candidate_commit,
            "dataset_revision": self.dataset_revision,
            "instance_id": self.instance_id,
            "model_digest": self.model_digest,
            "row_sha256": self.row_sha256,
        }

    @classmethod
    def from_dict(cls, value: object) -> AttemptKey:
        if not isinstance(value, dict) or set(value) != {
            "authority_profile_digest",
            "candidate_commit",
            "dataset_revision",
            "instance_id",
            "model_digest",
            "row_sha256",
        }:
            raise ValueError("attempt key contains unexpected fields")
        return cls(**value)

    def canonical_bytes(self) -> bytes:
        return _canonical_json(self.as_dict())


@dataclass(frozen=True)
class SignedClaim:
    key: AttemptKey
    ordinal: int
    reason: str
    signature: str

    def __post_init__(self) -> None:
        if type(self.ordinal) is not int or self.ordinal <= 0:
            raise ValueError("claim ordinal must be positive")
        _nonempty(self.reason, "claim reason")
        if not isinstance(self.signature, str) or not self.signature:
            raise ValueError("claim signature must be non-empty base64")
        try:
            base64.b64decode(self.signature, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValueError("claim signature must be non-empty base64") from error

    def payload_dict(self) -> dict[str, object]:
        return {
            "key": self.key.as_dict(),
            "ordinal": self.ordinal,
            "reason": self.reason,
        }

    def signing_bytes(self) -> bytes:
        return _canonical_json(self.payload_dict())

    def as_dict(self) -> dict[str, object]:
        return {**self.payload_dict(), "signature": self.signature}

    def canonical_bytes(self) -> bytes:
        return _canonical_json(self.as_dict())

    @classmethod
    def from_bytes(cls, content: bytes) -> SignedClaim:
        try:
            value = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("claim is not valid UTF-8 JSON") from error
        if not isinstance(value, dict) or set(value) != {"key", "ordinal", "reason", "signature"}:
            raise ValueError("claim contains unexpected fields")
        claim = cls(
            key=AttemptKey.from_dict(value["key"]),
            ordinal=value["ordinal"],
            reason=value["reason"],
            signature=value["signature"],
        )
        if claim.canonical_bytes() != content:
            raise ValueError("claim is not canonical JSON")
        return claim


@dataclass(frozen=True)
class GateSigner:
    private_key: Path

    def sign(self, payload: bytes) -> bytes:
        key_fd = _open_regular_nofollow(self.private_key, "gate private key")
        payload_fd = -1
        try:
            payload_fd = _sealed_memfd("alloy-gate-signing-payload", payload)
            result = subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-sign",
                    "-rawin",
                    "-inkey",
                    _descriptor_path(key_fd),
                    "-in",
                    _descriptor_path(payload_fd),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(key_fd, payload_fd),
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError("gate claim signing failed") from error
        finally:
            if payload_fd >= 0:
                os.close(payload_fd)
            os.close(key_fd)
        if not result.stdout:
            raise ValueError("gate claim signing returned an empty signature")
        return result.stdout


def _path_parts(path: Path) -> tuple[int, tuple[str, ...]]:
    absolute = path.is_absolute()
    base_fd = os.open("/" if absolute else ".", _DIRECTORY_FLAGS)
    parts = tuple(part for part in path.parts if part not in {path.anchor, "", "."})
    if not parts or any(part == ".." for part in parts):
        os.close(base_fd)
        raise ValueError("state directory must have a stable path")
    return base_fd, parts


def _open_state_directory(path: Path) -> int:
    current_fd, parts = _path_parts(path)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        leaf = parts[-1]
        try:
            os.mkdir(leaf, 0o700, dir_fd=current_fd)
            os.fsync(current_fd)
        except FileExistsError:
            pass
        directory_fd = os.open(leaf, _DIRECTORY_FLAGS, dir_fd=current_fd)
    except OSError as error:
        raise ValueError("state directory must not be a symlink and must have safe ancestors") from error
    finally:
        os.close(current_fd)
    details = os.fstat(directory_fd)
    if not stat.S_ISDIR(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o700:
        os.close(directory_fd)
        raise ValueError("state directory must be mode 0700")
    if hasattr(os, "geteuid") and details.st_uid != os.geteuid():
        os.close(directory_fd)
        raise ValueError("state directory must be owned by the current user")
    return directory_fd


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while persisting claim")
        view = view[written:]


def _claim_names(key: AttemptKey, ordinal: int) -> tuple[str, str]:
    digest = hashlib.sha256(key.canonical_bytes()).hexdigest()
    prefix = f"{digest}.attempt-{ordinal}"
    return f"{prefix}.reserved", f"{prefix}.claim.json"


def _persist_claim(state_fd: int, claim: SignedClaim, duplicate_message: str) -> None:
    reservation, destination = _claim_names(claim.key, claim.ordinal)
    try:
        reservation_fd = os.open(
            reservation,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=state_fd,
        )
    except FileExistsError as error:
        raise FileExistsError(duplicate_message) from error
    try:
        _write_all(reservation_fd, claim.signing_bytes())
        os.fsync(reservation_fd)
    finally:
        os.close(reservation_fd)
    os.fsync(state_fd)

    temporary = f".{destination}.{secrets.token_hex(16)}.tmp"
    temporary_fd = -1
    try:
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=state_fd,
        )
        _write_all(temporary_fd, claim.canonical_bytes())
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = -1
        try:
            os.stat(destination, dir_fd=state_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(duplicate_message)
        os.replace(temporary, destination, src_dir_fd=state_fd, dst_dir_fd=state_fd)
        os.fsync(state_fd)
    except BaseException:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary, dir_fd=state_fd)
        except FileNotFoundError:
            pass
        raise


def _signed_claim(key: AttemptKey, ordinal: int, reason: str, signer: GateSigner) -> SignedClaim:
    unsigned = {
        "key": key.as_dict(),
        "ordinal": ordinal,
        "reason": reason,
    }
    signature = signer.sign(_canonical_json(unsigned))
    return SignedClaim(key, ordinal, reason, base64.b64encode(signature).decode("ascii"))


def claim_first_attempt(state_dir: Path, key: AttemptKey, signer: GateSigner) -> SignedClaim:
    state_fd = _open_state_directory(state_dir)
    try:
        claim = _signed_claim(key, 1, "initial attempt", signer)
        _persist_claim(state_fd, claim, "first attempt is already claimed")
    finally:
        os.close(state_fd)
    return claim


def authorize_retry(state_dir: Path, key: AttemptKey, reason: str, signer: GateSigner) -> SignedClaim:
    reason = _nonempty(reason, "retry reason")
    state_fd = _open_state_directory(state_dir)
    try:
        first_reservation, _ = _claim_names(key, 1)
        try:
            details = os.stat(first_reservation, dir_fd=state_fd, follow_symlinks=False)
        except FileNotFoundError as error:
            raise FileNotFoundError("first attempt has not been claimed") from error
        if not stat.S_ISREG(details.st_mode):
            raise ValueError("first attempt reservation is not a regular file")
        claim = _signed_claim(key, 2, reason, signer)
        _persist_claim(state_fd, claim, "retry is already authorized")
    finally:
        os.close(state_fd)
    return claim


def verify_claim(
    claim: SignedClaim,
    public_key: Path,
    expected_key: AttemptKey,
) -> None:
    if claim.ordinal not in {1, 2}:
        raise ValueError("claim ordinal must be 1 or 2")
    if claim.ordinal == 1 and claim.reason != "initial attempt":
        raise ValueError("ordinal 1 claim reason is invalid")
    if claim.ordinal == 2 and not claim.reason.strip():
        raise ValueError("ordinal 2 claim requires an explicit reason")
    if claim.key != expected_key:
        raise ValueError("claim attempt key does not match the expected key")
    try:
        signature = base64.b64decode(claim.signature, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("claim signature is invalid") from error
    key_fd = _open_regular_nofollow(public_key, "gate public key")
    payload_fd = -1
    signature_fd = -1
    try:
        payload_fd = _sealed_memfd("alloy-gate-verification-payload", claim.signing_bytes())
        signature_fd = _sealed_memfd("alloy-gate-verification-signature", signature)
        try:
            subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-verify",
                    "-pubin",
                    "-rawin",
                    "-inkey",
                    _descriptor_path(key_fd),
                    "-sigfile",
                    _descriptor_path(signature_fd),
                    "-in",
                    _descriptor_path(payload_fd),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(key_fd, payload_fd, signature_fd),
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise ValueError("claim signature verification failed") from error
    finally:
        if signature_fd >= 0:
            os.close(signature_fd)
        if payload_fd >= 0:
            os.close(payload_fd)
        os.close(key_fd)


def _read_persisted_claim(state_fd: int, name: str) -> bytes:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state_fd)
    except OSError as error:
        raise ValueError("persisted attempt claim is unavailable") from error
    try:
        details = os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o600:
            raise ValueError("persisted attempt claim must be a mode-0600 regular file")
        if details.st_size > 1024 * 1024:
            raise ValueError("persisted attempt claim is oversized")
        content = bytearray()
        while len(content) < details.st_size:
            chunk = os.read(fd, details.st_size - len(content))
            if not chunk:
                raise ValueError("persisted attempt claim changed while being read")
            content.extend(chunk)
        if os.read(fd, 1):
            raise ValueError("persisted attempt claim changed while being read")
        return bytes(content)
    finally:
        os.close(fd)


def _rollback_consumption(
    state_fd: int,
    names: tuple[str, ...],
    cause: BaseException,
) -> None:
    cleanup_error: OSError | None = None
    for name in names:
        try:
            os.unlink(name, dir_fd=state_fd)
        except FileNotFoundError:
            pass
        except OSError as error:
            cleanup_error = cleanup_error or error
    try:
        os.fsync(state_fd)
    except OSError as error:
        cleanup_error = cleanup_error or error
    if cleanup_error is not None:
        raise ConsumptionUncertainError(
            "claim consumption state is uncertain because rollback durability could not be proven"
        ) from cause


def _persist_consumption_marker(state_fd: int, consumed_name: str, content: bytes) -> None:
    temporary = f".{consumed_name}.{secrets.token_hex(16)}.tmp"
    temporary_fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=state_fd,
    )
    try:
        _write_all(temporary_fd, content)
        os.fsync(temporary_fd)
    except BaseException as error:
        close_error: OSError | None = None
        try:
            os.close(temporary_fd)
        except OSError as caught:
            close_error = caught
        _rollback_consumption(state_fd, (temporary,), close_error or error)
        if close_error is not None:
            raise close_error from error
        raise
    try:
        os.close(temporary_fd)
    except OSError as error:
        _rollback_consumption(state_fd, (temporary,), error)
        raise

    try:
        os.link(
            temporary,
            consumed_name,
            src_dir_fd=state_fd,
            dst_dir_fd=state_fd,
            follow_symlinks=False,
        )
    except FileExistsError as error:
        _rollback_consumption(state_fd, (temporary,), error)
        raise FileExistsError("claim ordinal is already consumed") from error
    except BaseException as error:
        _rollback_consumption(state_fd, (temporary,), error)
        raise

    try:
        os.unlink(temporary, dir_fd=state_fd)
        os.fsync(state_fd)
    except BaseException as error:
        _rollback_consumption(state_fd, (consumed_name, temporary), error)
        raise


def consume_claim(
    state_dir: Path,
    claim: SignedClaim,
    public_key: Path,
    expected_key: AttemptKey,
) -> None:
    verify_claim(claim, public_key, expected_key)
    state_fd = _open_state_directory(state_dir)
    try:
        _, claim_name = _claim_names(claim.key, claim.ordinal)
        if _read_persisted_claim(state_fd, claim_name) != claim.canonical_bytes():
            raise ValueError("persisted attempt claim does not match the launch claim")
        consumed_name = claim_name.removesuffix(".claim.json") + ".consumed"
        marker = hashlib.sha256(claim.canonical_bytes()).hexdigest().encode("ascii")
        _persist_consumption_marker(state_fd, consumed_name, marker)
    finally:
        os.close(state_fd)
