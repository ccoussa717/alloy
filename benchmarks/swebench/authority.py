from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping, Sequence


FULL_GIT_SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class ReleaseTransformPolicy:
    old_version: str
    new_version: str
    release_date: str
    json_pointers: Mapping[str, tuple[str, ...]]
    literals: Mapping[str, int]
    changelog_path: str = "CHANGELOG.md"

    def __post_init__(self) -> None:
        if (
            not isinstance(self.old_version, str)
            or VERSION.fullmatch(self.old_version) is None
            or not isinstance(self.new_version, str)
            or VERSION.fullmatch(self.new_version) is None
        ):
            raise ValueError("release versions must be semantic versions")
        if self.old_version == self.new_version:
            raise ValueError("release versions must differ")
        if not isinstance(self.release_date, str) or DATE.fullmatch(self.release_date) is None:
            raise ValueError("release_date must be YYYY-MM-DD")
        json_pointers = {
            _relative_path(path): tuple(_json_pointer(pointer) for pointer in pointers)
            for path, pointers in self.json_pointers.items()
        }
        literals = {
            _relative_path(path): _positive_int(count, f"literal count for {path}")
            for path, count in self.literals.items()
        }
        changelog_path = _relative_path(self.changelog_path)
        paths = set(json_pointers) | set(literals) | {changelog_path}
        if len(paths) != len(json_pointers) + len(literals) + 1:
            raise ValueError("release policy paths must be distinct")
        object.__setattr__(self, "json_pointers", MappingProxyType(json_pointers))
        object.__setattr__(self, "literals", MappingProxyType(literals))
        object.__setattr__(self, "changelog_path", changelog_path)

    @property
    def allowed_paths(self) -> tuple[str, ...]:
        return tuple(sorted((*self.json_pointers, *self.literals, self.changelog_path)))


@dataclass(frozen=True)
class VerifiedCandidate:
    authority_commit: str
    candidate_commit: str
    version: str
    changed_paths: tuple[str, ...]


@dataclass(frozen=True)
class HostConfig:
    authority_commit: str
    coordinator_tree_sha256: str
    confinement_policy_sha256: Mapping[str, str]
    gate_public_key_sha256: str


@dataclass(frozen=True)
class _TreeEntry:
    mode: str
    object_type: str
    object_id: str
    path: str


def _relative_path(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("policy paths must be non-empty strings")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise ValueError(f"policy path must be repository-relative: {value}")
    return value


def _json_pointer(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("JSON pointers must start with /")
    for escape in re.findall(r"~.", value):
        if escape not in {"~0", "~1"}:
            raise ValueError(f"invalid JSON pointer escape: {escape}")
    return value


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be positive")
    return value


def _git(repository: Path, arguments: Sequence[str], *, text: bool = False) -> bytes | str:
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=repository,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=text,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", b"")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        raise ValueError(f"Git command failed: {stderr.strip()}") from error
    return result.stdout


def _resolve_commit(repository: Path, commit: str, label: str) -> str:
    resolved = str(_git(repository, ["rev-parse", "--verify", f"{commit}^{{commit}}"], text=True)).strip()
    if FULL_GIT_SHA.fullmatch(resolved) is None:
        raise ValueError(f"{label} did not resolve to a full Git commit")
    return resolved


def _tree(repository: Path, commit: str) -> dict[str, _TreeEntry]:
    output = bytes(_git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit]))
    entries: dict[str, _TreeEntry] = {}
    for record in output.split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        path = raw_path.decode("utf-8", "strict")
        entries[path] = _TreeEntry(mode, object_type, object_id, path)
    return entries


def _blob(repository: Path, commit: str, path: str) -> bytes:
    return bytes(_git(repository, ["show", f"{commit}:{path}"]))


def _pointer_parts(pointer: str) -> tuple[str, ...]:
    return tuple(part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/"))


def _pointer_value(document: object, pointer: str) -> object:
    value = document
    for part in _pointer_parts(pointer):
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise ValueError(f"JSON pointer does not exist: {pointer}")
    return value


def _set_pointer(document: object, pointer: str, replacement: object) -> None:
    parts = _pointer_parts(pointer)
    value = document
    for part in parts[:-1]:
        if not isinstance(value, dict) or part not in value:
            raise ValueError(f"JSON pointer does not exist: {pointer}")
        value = value[part]
    if not isinstance(value, dict) or parts[-1] not in value:
        raise ValueError(f"JSON pointer does not exist: {pointer}")
    value[parts[-1]] = replacement


def _verify_json_blob(path: str, authority: bytes, candidate: bytes, policy: ReleaseTransformPolicy) -> None:
    try:
        old_document = json.loads(authority)
        new_document = json.loads(candidate)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{path} must contain valid UTF-8 JSON") from error
    pointers = policy.json_pointers[path]
    for pointer in pointers:
        if _pointer_value(old_document, pointer) != policy.old_version:
            raise ValueError(f"{path} authority value at {pointer} is not {policy.old_version}")
        if _pointer_value(new_document, pointer) != policy.new_version:
            raise ValueError(f"{path} candidate value at {pointer} is not {policy.new_version}")
        _set_pointer(new_document, pointer, policy.old_version)
    if new_document != old_document:
        raise ValueError(f"{path} changes values outside the approved JSON pointers")
    old_token = json.dumps(policy.old_version).encode()
    new_token = json.dumps(policy.new_version).encode()
    if candidate.count(new_token) != len(pointers) or candidate.replace(new_token, old_token) != authority:
        raise ValueError(f"{path} release transformation is not byte-exact")


def _verify_literal_blob(path: str, authority: bytes, candidate: bytes, policy: ReleaseTransformPolicy) -> None:
    old = policy.old_version.encode()
    new = policy.new_version.encode()
    expected = policy.literals[path]
    if authority.count(old) != expected or authority.count(new) != 0:
        raise ValueError(f"{path} authority literal count does not match policy")
    if candidate.count(old) != 0 or candidate.count(new) != expected:
        raise ValueError(f"{path} candidate literal count does not match policy")
    if candidate.replace(new, old) != authority:
        raise ValueError(f"{path} contains changes beyond the approved version literals")


def _expected_changelog(authority: bytes, policy: ReleaseTransformPolicy) -> bytes:
    try:
        text = authority.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("authority changelog must be UTF-8") from error
    heading = "## [Unreleased]"
    start = text.find(heading)
    if start < 0 or text.find(heading, start + len(heading)) >= 0:
        raise ValueError("authority changelog must contain one Unreleased heading")
    content_start = start + len(heading)
    next_heading = text.find("\n## [", content_start)
    if next_heading < 0:
        raise ValueError("authority changelog needs a release after Unreleased")
    content = text[content_start:next_heading]
    if not content.strip():
        raise ValueError("authority changelog Unreleased section is empty")
    release_heading = f"## [{policy.new_version}] - {policy.release_date}"
    return (
        text[:content_start]
        + "\n\n"
        + release_heading
        + content
        + text[next_heading:]
    ).encode()


def verify_candidate(
    repository: Path,
    authority_commit: str,
    candidate_commit: str,
    policy: ReleaseTransformPolicy,
) -> VerifiedCandidate:
    repository = repository.resolve()
    if not repository.is_dir():
        raise ValueError("repository must be an existing directory")
    authority = _resolve_commit(repository, authority_commit, "authority_commit")
    candidate = _resolve_commit(repository, candidate_commit, "candidate_commit")
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", authority, candidate],
        cwd=repository,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if ancestor.returncode != 0:
        raise ValueError("authority commit must be an ancestor of candidate commit")

    authority_tree = _tree(repository, authority)
    candidate_tree = _tree(repository, candidate)
    all_paths = set(authority_tree) | set(candidate_tree)
    changed_paths = {
        path for path in all_paths if authority_tree.get(path) != candidate_tree.get(path)
    }
    unauthorized = changed_paths - set(policy.allowed_paths)
    if unauthorized:
        raise ValueError(f"candidate changes unauthorized path: {sorted(unauthorized)[0]}")
    missing = set(policy.allowed_paths) - changed_paths
    if missing:
        raise ValueError(f"candidate is missing required release transformation: {sorted(missing)[0]}")
    for path in policy.allowed_paths:
        old_entry = authority_tree.get(path)
        new_entry = candidate_tree.get(path)
        if old_entry is None or new_entry is None:
            raise ValueError(f"release path must exist in both trees: {path}")
        if (old_entry.mode, old_entry.object_type) != (new_entry.mode, new_entry.object_type):
            raise ValueError(f"release path mode or object type changed: {path}")

    for path in policy.json_pointers:
        _verify_json_blob(path, _blob(repository, authority, path), _blob(repository, candidate, path), policy)
    for path in policy.literals:
        _verify_literal_blob(
            path, _blob(repository, authority, path), _blob(repository, candidate, path), policy
        )
    changelog = policy.changelog_path
    if _blob(repository, candidate, changelog) != _expected_changelog(
        _blob(repository, authority, changelog), policy
    ):
        raise ValueError("candidate changelog is not the exact approved release extraction")
    return VerifiedCandidate(authority, candidate, policy.new_version, tuple(sorted(changed_paths)))


def coordinator_tree_digest(repository: Path, authority_commit: str, paths: tuple[str, ...]) -> str:
    authority = _resolve_commit(repository.resolve(), authority_commit, "authority_commit")
    tree = _tree(repository.resolve(), authority)
    normalized = sorted({_relative_path(path) for path in paths})
    if not normalized:
        raise ValueError("coordinator digest paths must not be empty")
    digest = hashlib.sha256()
    for path in normalized:
        entry = tree.get(path)
        if entry is None:
            raise ValueError(f"coordinator digest path is missing: {path}")
        digest.update(f"{entry.mode}\0{entry.object_type}\0{entry.object_id}\0{path}\0".encode())
    return digest.hexdigest()


def _parse_policy(content: bytes) -> ReleaseTransformPolicy:
    try:
        raw = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("release transform policy blob is invalid") from error
    if not isinstance(raw, dict):
        raise ValueError("release transform policy must be a JSON object")
    expected = {
        "old_version",
        "new_version",
        "release_date",
        "json_pointers",
        "literals",
        "changelog_path",
    }
    if set(raw) != expected:
        raise ValueError("release transform policy must contain exactly the reviewed keys")
    pointers = raw["json_pointers"]
    literals = raw["literals"]
    if not isinstance(pointers, dict) or not all(isinstance(value, list) for value in pointers.values()):
        raise ValueError("json_pointers must map paths to pointer arrays")
    if not isinstance(literals, dict):
        raise ValueError("literals must map paths to counts")
    return ReleaseTransformPolicy(
        old_version=raw["old_version"],
        new_version=raw["new_version"],
        release_date=raw["release_date"],
        json_pointers={key: tuple(value) for key, value in pointers.items()},
        literals=literals,
        changelog_path=raw["changelog_path"],
    )


def load_policy_from_commit(repository: Path, authority_commit: str) -> ReleaseTransformPolicy:
    repository = repository.resolve()
    authority = _resolve_commit(repository, authority_commit, "authority_commit")
    return _parse_policy(
        _blob(repository, authority, "benchmarks/swebench/release-transform.json")
    )


def _provisioned_hash(value: object, label: str, length: int) -> str:
    if value is None:
        raise ValueError(f"{label} is not provisioned")
    if not isinstance(value, str) or re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is None:
        raise ValueError(f"{label} must be a lowercase {length * 4}-bit hash")
    if value == "0" * length:
        raise ValueError(f"{label} must not be an all-zero placeholder")
    return value


def load_host_config(path: Path) -> HostConfig:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("host config is missing or invalid") from error
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
        raise ValueError("confinement_policy_sha256 must contain AppArmor and seccomp digests")
    return HostConfig(
        authority_commit=_provisioned_hash(raw["authority_commit"], "authority_commit", 40),
        coordinator_tree_sha256=_provisioned_hash(
            raw["coordinator_tree_sha256"], "coordinator_tree_sha256", 64
        ),
        confinement_policy_sha256=MappingProxyType(
            {
                name: _provisioned_hash(value, f"confinement_policy_sha256.{name}", 64)
                for name, value in policies.items()
            }
        ),
        gate_public_key_sha256=_provisioned_hash(
            raw["gate_public_key_sha256"], "gate_public_key_sha256", 64
        ),
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify an exact Alloy release candidate")
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--authority", "--authority-commit", dest="authority_commit", required=True)
    parser.add_argument("--candidate", "--candidate-commit", dest="candidate_commit", required=True)
    arguments = parser.parse_args(argv)
    authority = _resolve_commit(
        arguments.repository.resolve(), arguments.authority_commit, "authority_commit"
    )
    verified = verify_candidate(
        arguments.repository,
        authority,
        arguments.candidate_commit,
        load_policy_from_commit(arguments.repository, authority),
    )
    print(json.dumps({
        "authority_commit": verified.authority_commit,
        "candidate_commit": verified.candidate_commit,
        "version": verified.version,
        "changed_paths": verified.changed_paths,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
