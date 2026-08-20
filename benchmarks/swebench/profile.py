from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path


FULL_GIT_SHA = re.compile(r"[0-9a-f]{40}")
SEMANTIC_VERSION = re.compile(
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
REVIEWED_ROUTES = (
    ("GET", "/api/tags"),
    ("POST", "/api/show"),
    ("POST", "/v1/chat/completions"),
)


@dataclass(frozen=True)
class DatasetPin:
    name: str
    split: str
    revision: str
    parquet_path: str
    parquet_sha256: str
    row_sha256: str
    instance_id: str
    base_commit: str


@dataclass(frozen=True)
class ImagePin:
    reference: str
    manifest_digest: str
    platform: str


@dataclass(frozen=True)
class SecurityPolicy:
    seccomp_path: str
    seccomp_sha256: str
    apparmor_path: str
    apparmor_sha256: str
    apparmor_name: str


@dataclass(frozen=True)
class ResourceLimits:
    agent_timeout_seconds: int
    evaluator_timeout_seconds: int
    pids: int
    memory_bytes: int
    cpus: int
    max_files: int
    max_file_bytes: int
    max_export_bytes: int


@dataclass(frozen=True)
class ProxyPolicy:
    allowed_routes: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class BenchmarkProfile:
    canonical_repository: str
    dataset: DatasetPin
    model: str
    model_digest: str
    ollama_model: str
    swebench_version: str
    agent_image: ImagePin
    proxy_image: ImagePin
    evaluator_image: ImagePin
    security_policy: SecurityPolicy
    limits: ResourceLimits
    proxy: ProxyPolicy

    @property
    def instance_id(self) -> str:
        return self.dataset.instance_id

    @property
    def base_commit(self) -> str:
        return self.dataset.base_commit

    @property
    def split(self) -> str:
        return self.dataset.split

    @property
    def agent_timeout_seconds(self) -> int:
        return self.limits.agent_timeout_seconds

    @property
    def evaluator_timeout_seconds(self) -> int:
        return self.limits.evaluator_timeout_seconds


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _keys(value: dict[str, object], expected: set[str], label: str) -> None:
    unknown = set(value) - expected
    missing = expected - set(value)
    if unknown:
        raise ValueError(f"unknown {label} keys: {sorted(unknown)}")
    if missing:
        raise ValueError(f"missing {label} keys: {sorted(missing)}")


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256")
    return value


def _manifest_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a sha256 image manifest digest")
    return value


def _git_sha(value: object, label: str) -> str:
    if not isinstance(value, str) or FULL_GIT_SHA.fullmatch(value) is None:
        raise ValueError(f"{label} must be a full lowercase Git SHA")
    return value


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be positive")
    return value


def _dataset(value: object) -> DatasetPin:
    raw = _object(value, "dataset")
    _keys(
        raw,
        {
            "name",
            "split",
            "revision",
            "parquet_path",
            "parquet_sha256",
            "row_sha256",
            "instance_id",
            "base_commit",
        },
        "dataset",
    )
    return DatasetPin(
        name=_string(raw["name"], "dataset.name"),
        split=_string(raw["split"], "dataset.split"),
        revision=_git_sha(raw["revision"], "dataset.revision"),
        parquet_path=_string(raw["parquet_path"], "dataset.parquet_path"),
        parquet_sha256=_sha256(raw["parquet_sha256"], "dataset.parquet_sha256"),
        row_sha256=_sha256(raw["row_sha256"], "dataset.row_sha256"),
        instance_id=_string(raw["instance_id"], "dataset.instance_id"),
        base_commit=_git_sha(raw["base_commit"], "dataset.base_commit"),
    )


def _image(value: object, label: str) -> ImagePin:
    raw = _object(value, label)
    _keys(raw, {"reference", "manifest_digest", "platform"}, label)
    digest = _manifest_digest(raw["manifest_digest"], f"{label}.manifest_digest")
    reference = _string(raw["reference"], f"{label}.reference")
    if not reference.endswith(f"@{digest}"):
        raise ValueError(f"{label}.reference must be digest-qualified by its manifest_digest")
    platform = _string(raw["platform"], f"{label}.platform")
    if platform != "linux/amd64":
        raise ValueError(f"{label}.platform must be linux/amd64")
    return ImagePin(reference, digest, platform)


def _limits(value: object) -> ResourceLimits:
    raw = _object(value, "limits")
    names = {
        "agent_timeout_seconds",
        "evaluator_timeout_seconds",
        "pids",
        "memory_bytes",
        "cpus",
        "max_files",
        "max_file_bytes",
        "max_export_bytes",
    }
    _keys(raw, names, "limits")
    return ResourceLimits(**{name: _positive_int(raw[name], f"limits.{name}") for name in names})


def _proxy(value: object) -> ProxyPolicy:
    raw = _object(value, "proxy")
    _keys(raw, {"allowed_routes"}, "proxy")
    routes = raw["allowed_routes"]
    if not isinstance(routes, list):
        raise ValueError("proxy.allowed_routes must equal the reviewed routes")
    normalized = tuple(tuple(route) if isinstance(route, list) else () for route in routes)
    if normalized != REVIEWED_ROUTES:
        raise ValueError("proxy.allowed_routes must equal the reviewed routes")
    return ProxyPolicy(REVIEWED_ROUTES)


def _policy_path(authority_root: Path, value: object, label: str) -> tuple[str, Path]:
    relative = _string(value, label)
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"{label} must be an authority-relative path")
    root = authority_root.resolve()
    path = (root / candidate).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"{label} must name an authority-owned file")
    return relative, path


def _security_policy(value: object, authority_root: Path) -> SecurityPolicy:
    raw = _object(value, "security_policy")
    _keys(
        raw,
        {
            "seccomp_path",
            "seccomp_sha256",
            "apparmor_path",
            "apparmor_sha256",
            "apparmor_name",
        },
        "security_policy",
    )
    seccomp_path, seccomp = _policy_path(
        authority_root, raw["seccomp_path"], "security_policy.seccomp_path"
    )
    apparmor_path, apparmor = _policy_path(
        authority_root, raw["apparmor_path"], "security_policy.apparmor_path"
    )
    seccomp_sha256 = _sha256(raw["seccomp_sha256"], "security_policy.seccomp_sha256")
    apparmor_sha256 = _sha256(raw["apparmor_sha256"], "security_policy.apparmor_sha256")
    if hashlib.sha256(seccomp.read_bytes()).hexdigest() != seccomp_sha256:
        raise ValueError("seccomp policy SHA-256 mismatch")
    if hashlib.sha256(apparmor.read_bytes()).hexdigest() != apparmor_sha256:
        raise ValueError("AppArmor policy SHA-256 mismatch")
    return SecurityPolicy(
        seccomp_path,
        seccomp_sha256,
        apparmor_path,
        apparmor_sha256,
        _string(raw["apparmor_name"], "security_policy.apparmor_name"),
    )


def parse_profile(value: object, authority_root: Path) -> BenchmarkProfile:
    raw = _object(value, "benchmark profile")
    expected = {
        "canonical_repository",
        "dataset",
        "model",
        "model_digest",
        "ollama_model",
        "swebench_version",
        "agent_image",
        "proxy_image",
        "evaluator_image",
        "security_policy",
        "limits",
        "proxy",
    }
    _keys(raw, expected, "benchmark profile")
    version = _string(raw["swebench_version"], "swebench_version")
    if SEMANTIC_VERSION.fullmatch(version) is None:
        raise ValueError("swebench_version must be a semantic version")
    return BenchmarkProfile(
        canonical_repository=_string(raw["canonical_repository"], "canonical_repository"),
        dataset=_dataset(raw["dataset"]),
        model=_string(raw["model"], "model"),
        model_digest=_sha256(raw["model_digest"], "model_digest"),
        ollama_model=_string(raw["ollama_model"], "ollama_model"),
        swebench_version=version,
        agent_image=_image(raw["agent_image"], "agent_image"),
        proxy_image=_image(raw["proxy_image"], "proxy_image"),
        evaluator_image=_image(raw["evaluator_image"], "evaluator_image"),
        security_policy=_security_policy(raw["security_policy"], authority_root),
        limits=_limits(raw["limits"]),
        proxy=_proxy(raw["proxy"]),
    )


def load_profile(path: Path, authority_root: Path) -> BenchmarkProfile:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("benchmark profile is missing or invalid") from error
    return parse_profile(value, authority_root)
