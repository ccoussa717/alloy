from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from benchmarks.swebench.authority import VerifiedCandidate
from benchmarks.swebench.install import FetchedCandidate, VerifiedArtifact
from benchmarks.swebench.profile import BenchmarkProfile
from benchmarks.swebench.runner import load_candidate_metadata


CANDIDATE_ORIGIN = "https://codeload.github.com"
NPM_ORIGINS = frozenset({
    "https://registry.npmjs.org",
    "https://github.com",
})
BUN_URL = (
    "https://github.com/oven-sh/bun/releases/download/"
    "bun-v1.3.14/bun-linux-x64-baseline.zip"
)
BUN_SHA256 = "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"
FULL_SHA = re.compile(r"[0-9a-f]{40}")
REDIRECT_ORIGINS = frozenset({
    "https://objects.githubusercontent.com",
    "https://release-assets.githubusercontent.com",
})


Downloader = Callable[[str], bytes]


class _ArchiveBudget:
    def __init__(self, profile: BenchmarkProfile, label: str) -> None:
        self.max_files = profile.limits.max_files
        self.max_file_bytes = profile.limits.max_file_bytes
        self.max_total_bytes = profile.limits.max_export_bytes
        self.label = label
        self.count = 0
        self.total_bytes = 0

    def observe(self, size: int) -> None:
        self.count += 1
        if self.count > self.max_files:
            raise RuntimeError(f"{self.label} exceeds the profile file-count bound")
        if size < 0 or size > self.max_file_bytes:
            raise RuntimeError(f"{self.label} member exceeds the profile per-file bound")
        if size > self.max_total_bytes - self.total_bytes:
            raise RuntimeError(f"{self.label} exceeds the profile total-byte bound")
        self.total_bytes += size


def _url_origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise RuntimeError("artifact URL is not on an allowlisted HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc}"


class _AllowlistedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, origins: frozenset[str]) -> None:
        self.origins = origins

    def redirect_request(self, request, fp, code, message, headers, new_url):
        if _url_origin(new_url) not in self.origins | REDIRECT_ORIGINS:
            raise RuntimeError("artifact redirect left the allowlisted HTTPS origins")
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _download(url: str) -> bytes:
    raise RuntimeError("default downloads require profile-bounded ArtifactFetcher._fetch")


def _download_bounded(url: str, origins: frozenset[str], limit: int) -> bytes:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _AllowlistedRedirects(origins),
    )
    request = urllib.request.Request(url, headers={"User-Agent": "alloy-swebench-gate"})
    try:
        with opener.open(request, timeout=120) as response:
            if _url_origin(response.geturl()) not in origins | REDIRECT_ORIGINS:
                raise RuntimeError("artifact redirect left the allowlisted HTTPS origins")
            output = io.BytesIO()
            while True:
                chunk = response.read(min(1024 * 1024, limit + 1 - output.tell()))
                if not chunk:
                    return output.getvalue()
                output.write(chunk)
                if output.tell() > limit:
                    raise RuntimeError("download exceeds the profile total-byte bound")
    except OSError as error:
        raise RuntimeError(f"could not download verified artifact: {url}") from error


def _git_hash(kind: str, content: bytes) -> bytes:
    return hashlib.sha1(
        f"{kind} {len(content)}\0".encode() + content,
        usedforsecurity=False,
    ).digest()


def _tree_digest(entries: dict[str, tuple[int, bytes]]) -> str:
    tree: dict[str, object] = {}
    for path, value in entries.items():
        node = tree
        parts = path.split("/")
        for part in parts[:-1]:
            child = node.setdefault(part, {})
            if not isinstance(child, dict):
                raise RuntimeError("candidate archive path changes type")
            node = child
        if parts[-1] in node:
            raise RuntimeError("candidate archive repeats a path")
        node[parts[-1]] = value

    def encode(node: dict[str, object]) -> bytes:
        records = []
        for name, value in node.items():
            raw_name = name.encode("utf-8")
            if isinstance(value, dict):
                mode = b"40000"
                object_id = _git_hash("tree", encode(value))
                sort_key = raw_name + b"/"
            else:
                mode_value, object_id = value
                mode = f"{mode_value:o}".encode("ascii")
                sort_key = raw_name
            records.append((sort_key, mode + b" " + raw_name + b"\0" + object_id))
        return b"".join(record for _, record in sorted(records))

    return _git_hash("tree", encode(tree)).hex()


def _verified_archive_files(
    content: bytes,
    expected_tree: str,
    profile: BenchmarkProfile,
    *,
    reject_dot_git: bool = False,
) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    objects: dict[str, tuple[int, bytes]] = {}
    seen: set[str] = set()
    root: str | None = None
    budget = _ArchiveBudget(profile, "archive")
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r|*") as archive:
            for member in archive:
                payload_size = (
                    member.size if member.isreg()
                    else len(member.linkname.encode("utf-8")) if member.issym()
                    else 0
                )
                budget.observe(payload_size)
                if not member.name:
                    raise RuntimeError("archive contains an empty path")
                member_root = member.name.split("/", 1)[0]
                if root is None:
                    root = member_root
                elif member_root != root:
                    raise RuntimeError("archive must have one top-level directory")
                name = member.name.rstrip("/")
                if name in seen:
                    raise RuntimeError("archive contains a duplicate path")
                seen.add(name)
                if name == root:
                    continue
                prefix = root + "/"
                if not name.startswith(prefix):
                    raise RuntimeError("archive escaped its top-level directory")
                relative = name[len(prefix):]
                path = Path(relative)
                if not relative or path.is_absolute() or ".." in path.parts:
                    raise RuntimeError("archive contains an unsafe path")
                if reject_dot_git and ".git" in path.parts:
                    raise RuntimeError("target archive contains a forbidden .git entry")
                if member.isdir():
                    continue
                if member.isreg():
                    source = archive.extractfile(member)
                    if source is None:
                        raise RuntimeError("archive file is unreadable")
                    data = source.read(profile.limits.max_file_bytes + 1)
                    if len(data) != member.size:
                        raise RuntimeError("archive member size is inconsistent")
                    mode = 0o100755 if member.mode & 0o111 else 0o100644
                elif member.issym():
                    data = member.linkname.encode("utf-8")
                    mode = 0o120000
                else:
                    raise RuntimeError("archive contains a special file")
                files[relative] = data
                objects[relative] = (mode, _git_hash("blob", data))
    except (tarfile.TarError, UnicodeError, OSError) as error:
        raise RuntimeError("archive is invalid") from error
    if root is None:
        raise RuntimeError("archive is empty")
    if _tree_digest(objects) != expected_tree:
        raise RuntimeError("archive does not match the verified Git tree")
    return files


def _json_object(content: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is invalid") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    return value


class ArtifactFetcher:
    def __init__(
        self,
        repository: Path,
        cache_root: Path,
        *,
        downloader: Downloader = _download,
        profile: BenchmarkProfile | None = None,
        target_repository: Path | None = None,
    ) -> None:
        self.repository = repository.resolve()
        self.cache_root = cache_root.resolve()
        self.downloader = downloader
        self._default_downloader = downloader is _download
        self.profile = profile
        self.target_repository = target_repository.resolve() if target_repository else None
        self.requested_urls: list[str] = []
        if not self.repository.is_dir():
            raise ValueError("repository must be an existing directory")
        if not self.cache_root.is_relative_to(self.repository):
            raise ValueError("artifact cache must be beneath the trusted repository")
        self.cache_root.mkdir(parents=True, exist_ok=True)

    def _profile(self) -> BenchmarkProfile:
        if self.profile is None:
            raise ValueError("artifact fetch requires the pinned benchmark profile")
        return self.profile

    def _fetch(self, url: str, origins: frozenset[str]) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        origin = _url_origin(url)
        if (
            parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or origin not in origins
            or parsed.fragment
        ):
            raise RuntimeError("artifact URL is not on an allowlisted HTTPS origin")
        if origin == "https://github.com" and not (
            parsed.path.startswith("/ccoussa717/pi/releases/download/")
            or url == BUN_URL
        ):
            raise RuntimeError("artifact URL is not on an allowlisted HTTPS origin")
        self.requested_urls.append(url)
        if self._default_downloader:
            content = _download_bounded(
                url, origins, self._profile().limits.max_export_bytes,
            )
        else:
            content = self.downloader(url)
        if len(content) > self._profile().limits.max_export_bytes:
            raise RuntimeError("download exceeds the profile total-byte bound")
        return content

    def _publish(self, name: str, content: bytes) -> VerifiedArtifact:
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+", name) is None:
            raise ValueError("cache artifact name is unsafe")
        path = self.cache_root / name
        temporary = self.cache_root / f".{name}.{os.getpid()}.tmp"
        try:
            with temporary.open("xb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o444)
            os.replace(temporary, path)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return VerifiedArtifact(path, hashlib.sha256(content).hexdigest(), len(content))

    def fetch_candidate(self, candidate: VerifiedCandidate) -> FetchedCandidate:
        if FULL_SHA.fullmatch(candidate.candidate_commit) is None:
            raise ValueError("candidate commit must be a full lowercase Git SHA")
        url = f"{CANDIDATE_ORIGIN}/ccoussa717/alloy/tar.gz/{candidate.candidate_commit}"
        content = self._fetch(url, frozenset({CANDIDATE_ORIGIN}))
        expected_tree = subprocess.run(
            ["git", "rev-parse", f"{candidate.candidate_commit}^{{tree}}"],
            cwd=self.repository,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        files = _verified_archive_files(content, expected_tree, self._profile())
        required = {"package.json", "npm-shrinkwrap.json", "tui/bun.lock", "install.sh"}
        if not required.issubset(files):
            raise RuntimeError("candidate archive is missing required installation files")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_bytes(files["package.json"])
            metadata = load_candidate_metadata(root, candidate.candidate_commit)
        if metadata.alloy_version != candidate.version:
            raise RuntimeError("candidate archive version differs from verified release policy")
        lock = files["npm-shrinkwrap.json"]
        bun_lock = files["tui/bun.lock"]
        _json_object(lock, "candidate npm shrinkwrap")
        artifact = self._publish(f"candidate-{candidate.candidate_commit}.tar", content)
        return FetchedCandidate(
            commit=candidate.candidate_commit,
            alloy_version=metadata.alloy_version,
            pi_version=metadata.pi_version,
            archive=artifact,
            lock_sha256=hashlib.sha256(lock).hexdigest(),
            bun_lock_sha256=hashlib.sha256(bun_lock).hexdigest(),
            lock=lock,
            bun_lock=bun_lock,
        )

    def fetch_npm_cache(self, lock: bytes | FetchedCandidate) -> VerifiedArtifact:
        lock_bytes = lock.lock if isinstance(lock, FetchedCandidate) else lock
        document = _json_object(lock_bytes, "candidate npm shrinkwrap")
        packages = document.get("packages")
        if not isinstance(packages, dict):
            raise RuntimeError("candidate npm shrinkwrap packages must be an object")
        artifacts: dict[str, bytes] = {}
        artifact_metadata: dict[str, dict[str, object]] = {}
        index: dict[str, str] = {}
        fetched_urls: dict[str, bytes] = {}
        fetched_total = 0
        fetched_count = 0

        def verified_package(url: str, integrity: str, label: str) -> bytes:
            nonlocal fetched_total, fetched_count
            if url in fetched_urls:
                return fetched_urls[url]
            content = self._fetch(url, NPM_ORIGINS)
            if len(content) > self._profile().limits.max_file_bytes:
                raise RuntimeError(f"{label} exceeds the profile per-file bound")
            fetched_count += 1
            fetched_total += len(content)
            if fetched_count > self._profile().limits.max_files:
                raise RuntimeError("package cache exceeds the profile file-count bound")
            if fetched_total > self._profile().limits.max_export_bytes:
                raise RuntimeError("package cache exceeds the profile total-byte bound")
            try:
                algorithm, encoded = integrity.split("-", 1)
                expected = base64.b64decode(encoded, validate=True)
                observed = hashlib.new(algorithm, content).digest()
            except (ValueError, TypeError) as error:
                raise RuntimeError(f"{label} integrity is invalid") from error
            if algorithm not in {"sha256", "sha512"} or observed != expected:
                raise RuntimeError(f"{label} integrity mismatch")
            fetched_urls[url] = content
            return content

        for package in packages.values():
            if not isinstance(package, dict) or "resolved" not in package:
                continue
            url = package["resolved"]
            integrity = package.get("integrity")
            if not isinstance(url, str) or not isinstance(integrity, str):
                raise RuntimeError("package artifact lacks resolved URL or integrity")
            content = verified_package(url, integrity, "package artifact")
            digest = hashlib.sha256(content).hexdigest()
            artifacts.setdefault(digest, content)
            index[url] = f"npm/artifacts/{digest}.tgz"
            artifact_metadata[url] = {
                "integrity": integrity, "sha256": digest, "size": len(content),
            }

        bun_packages: list[tuple[str, str, str, bytes]] = []
        if isinstance(lock, FetchedCandidate):
            try:
                bun_document = json.loads(re.sub(rb",(\s*[}\]])", rb"\1", lock.bun_lock))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RuntimeError("candidate Bun lock is invalid") from error
            packages_value = bun_document.get("packages") if isinstance(bun_document, dict) else None
            if not isinstance(packages_value, dict):
                raise RuntimeError("candidate Bun lock packages must be an object")
            for package in packages_value.values():
                if not isinstance(package, list) or len(package) < 4:
                    raise RuntimeError("candidate Bun lock package entry is invalid")
                spec, integrity = package[0], package[-1]
                if not isinstance(spec, str) or not isinstance(integrity, str):
                    raise RuntimeError("candidate Bun lock package identity is invalid")
                try:
                    name, version = spec.rsplit("@", 1)
                except ValueError as error:
                    raise RuntimeError("candidate Bun lock package identity is invalid") from error
                if not name or not version or "/" in version:
                    raise RuntimeError("candidate Bun lock package identity is invalid")
                basename = name.split("/")[-1]
                url = f"https://registry.npmjs.org/{name}/-/{basename}-{version}.tgz"
                content = verified_package(url, integrity, "Bun package artifact")
                digest = hashlib.sha256(content).hexdigest()
                artifact_metadata[url] = {
                    "integrity": integrity, "sha256": digest, "size": len(content),
                }
                bun_packages.append((name, version, url, content))

        package_budget = _ArchiveBudget(self._profile(), "Bun package archive")
        output_budget = _ArchiveBudget(self._profile(), "package cache")

        def add_output(archive: tarfile.TarFile, name: str, content: bytes, mode: int) -> None:
            output_budget.observe(len(content))
            member = tarfile.TarInfo(name)
            member.mode = mode
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))

        with tempfile.TemporaryFile() as output:
            with tarfile.open(fileobj=output, mode="w") as archive:
                for name, content in sorted(artifacts.items()):
                    add_output(archive, f"npm/artifacts/{name}.tgz", content, 0o444)
                encoded = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()
                add_output(archive, "npm/index.json", encoded, 0o444)
                for name, version, _, content in bun_packages:
                    cache_root = f"bun/{name}@{version}@@@1"
                    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as package_archive:
                        package_seen: set[str] = set()
                        for package_member in package_archive:
                            payload_size = (
                                package_member.size if package_member.isreg()
                                else len(package_member.linkname.encode("utf-8"))
                                if package_member.issym() else 0
                            )
                            package_budget.observe(payload_size)
                            if package_member.name in package_seen:
                                raise RuntimeError("Bun package contains a duplicate path")
                            package_seen.add(package_member.name)
                            if not package_member.isfile() or not package_member.name.startswith("package/"):
                                continue
                            source = package_archive.extractfile(package_member)
                            assert source is not None
                            data = source.read(package_member.size + 1)
                            if len(data) != package_member.size:
                                raise RuntimeError("Bun cache member size is inconsistent")
                            relative = package_member.name[len("package/"):]
                            relative_path = Path(relative)
                            if not relative or relative_path.is_absolute() or ".." in relative_path.parts:
                                raise RuntimeError("Bun package contains an unsafe path")
                            add_output(
                                archive, f"{cache_root}/{relative}", data,
                                package_member.mode & 0o777,
                            )
                cache_metadata = {
                    "schema_version": 1,
                    "npm_lock_sha256": hashlib.sha256(lock_bytes).hexdigest(),
                    "bun_lock_sha256": lock.bun_lock_sha256 if isinstance(lock, FetchedCandidate) else None,
                    "artifacts": artifact_metadata,
                }
                encoded = json.dumps(cache_metadata, sort_keys=True, separators=(",", ":")).encode()
                add_output(archive, "cache-metadata.json", encoded, 0o444)
            size = output.tell()
            if size > self._profile().limits.max_export_bytes:
                raise RuntimeError("package cache exceeds the profile total-byte bound")
            output.seek(0)
            cache_content = output.read(size + 1)
        digest = hashlib.sha256(lock_bytes).hexdigest()
        return self._publish(f"npm-cache-{digest}.tar", cache_content)

    def fetch_bun(self) -> VerifiedArtifact:
        content = self._fetch(BUN_URL, NPM_ORIGINS)
        if hashlib.sha256(content).hexdigest() != BUN_SHA256:
            raise RuntimeError("Bun archive SHA-256 mismatch")
        return self._publish("bun-linux-x64-baseline-1.3.14.zip", content)

    def fetch_target_source(self, profile: BenchmarkProfile) -> VerifiedArtifact:
        if profile.instance_id != "astropy__astropy-12907":
            raise ValueError("only the pinned Astropy target is supported")
        url = f"{CANDIDATE_ORIGIN}/astropy/astropy/tar.gz/{profile.base_commit}"
        content = self._fetch(url, frozenset({CANDIDATE_ORIGIN}))
        if self.target_repository is None or not self.target_repository.is_dir():
            raise RuntimeError("trusted target Git repository is unavailable")
        expected_tree = subprocess.run(
            ["git", "rev-parse", f"{profile.base_commit}^{{tree}}"],
            cwd=self.target_repository, check=True, capture_output=True, text=True,
        ).stdout.strip()
        _verified_archive_files(
            content, expected_tree, profile, reject_dot_git=True,
        )
        with tempfile.TemporaryDirectory() as directory:
            canonical = Path(directory) / "target.tar"
            subprocess.run(
                [
                    "git", "archive", "--format=tar", f"--prefix=astropy-{profile.base_commit}/",
                    f"--output={canonical}", profile.base_commit,
                ],
                cwd=self.target_repository, check=True, capture_output=True,
            )
            if canonical.stat().st_size > profile.limits.max_export_bytes:
                raise RuntimeError("canonical target archive exceeds the profile total-byte bound")
            canonical_content = canonical.read_bytes()
        _verified_archive_files(
            canonical_content, expected_tree, profile, reject_dot_git=True,
        )
        return self._publish(f"astropy-{profile.base_commit}.tar", canonical_content)
