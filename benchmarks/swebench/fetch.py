from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
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


Downloader = Callable[[str], bytes]


def _download(url: str) -> bytes:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={"User-Agent": "alloy-swebench-gate"})
    try:
        with opener.open(request, timeout=120) as response:
            if response.geturl() != url:
                raise RuntimeError("artifact download redirects are forbidden")
            return response.read()
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


def _verified_archive_files(content: bytes, expected_tree: str) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    objects: dict[str, tuple[int, bytes]] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
            members = archive.getmembers()
            roots = {member.name.split("/", 1)[0] for member in members if member.name}
            if len(roots) != 1:
                raise RuntimeError("candidate archive must have one top-level directory")
            root = next(iter(roots))
            for member in members:
                name = member.name.rstrip("/")
                if name == root:
                    continue
                prefix = root + "/"
                if not name.startswith(prefix):
                    raise RuntimeError("candidate archive escaped its top-level directory")
                relative = name[len(prefix):]
                path = Path(relative)
                if not relative or path.is_absolute() or ".." in path.parts:
                    raise RuntimeError("candidate archive contains an unsafe path")
                if member.isdir():
                    continue
                if member.isreg():
                    source = archive.extractfile(member)
                    if source is None:
                        raise RuntimeError("candidate archive file is unreadable")
                    data = source.read()
                    mode = 0o100755 if member.mode & 0o111 else 0o100644
                elif member.issym():
                    data = member.linkname.encode("utf-8")
                    mode = 0o120000
                else:
                    raise RuntimeError("candidate archive contains a special file")
                files[relative] = data
                objects[relative] = (mode, _git_hash("blob", data))
    except (tarfile.TarError, UnicodeError, OSError) as error:
        raise RuntimeError("candidate archive is invalid") from error
    if _tree_digest(objects) != expected_tree:
        raise RuntimeError("candidate archive does not match the verified Git tree")
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
    ) -> None:
        self.repository = repository.resolve()
        self.cache_root = cache_root.resolve()
        self.downloader = downloader
        self.requested_urls: list[str] = []
        if not self.repository.is_dir():
            raise ValueError("repository must be an existing directory")
        if not self.cache_root.is_relative_to(self.repository):
            raise ValueError("artifact cache must be beneath the trusted repository")
        self.cache_root.mkdir(parents=True, exist_ok=True)

    def _fetch(self, url: str, origins: frozenset[str]) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
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
        return self.downloader(url)

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
        files = _verified_archive_files(content, expected_tree)
        required = {"package.json", "npm-shrinkwrap.json", "install.sh"}
        if not required.issubset(files):
            raise RuntimeError("candidate archive is missing required installation files")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_bytes(files["package.json"])
            metadata = load_candidate_metadata(root, candidate.candidate_commit)
        if metadata.alloy_version != candidate.version:
            raise RuntimeError("candidate archive version differs from verified release policy")
        lock = files["npm-shrinkwrap.json"]
        _json_object(lock, "candidate npm shrinkwrap")
        artifact = self._publish(f"candidate-{candidate.candidate_commit}.tar", content)
        return FetchedCandidate(
            commit=candidate.candidate_commit,
            alloy_version=metadata.alloy_version,
            pi_version=metadata.pi_version,
            archive=artifact,
            lock_sha256=hashlib.sha256(lock).hexdigest(),
            lock=lock,
        )

    def fetch_npm_cache(self, lock: bytes | FetchedCandidate) -> VerifiedArtifact:
        lock_bytes = lock.lock if isinstance(lock, FetchedCandidate) else lock
        document = _json_object(lock_bytes, "candidate npm shrinkwrap")
        packages = document.get("packages")
        if not isinstance(packages, dict):
            raise RuntimeError("candidate npm shrinkwrap packages must be an object")
        artifacts: dict[str, bytes] = {}
        index: dict[str, str] = {}
        for package in packages.values():
            if not isinstance(package, dict) or "resolved" not in package:
                continue
            url = package["resolved"]
            integrity = package.get("integrity")
            if not isinstance(url, str) or not isinstance(integrity, str):
                raise RuntimeError("package artifact lacks resolved URL or integrity")
            content = self._fetch(url, NPM_ORIGINS)
            try:
                algorithm, encoded = integrity.split("-", 1)
                expected = base64.b64decode(encoded, validate=True)
                observed = hashlib.new(algorithm, content).digest()
            except (ValueError, TypeError) as error:
                raise RuntimeError("package artifact integrity is invalid") from error
            if algorithm not in {"sha256", "sha512"} or observed != expected:
                raise RuntimeError("package artifact integrity mismatch")
            digest = hashlib.sha256(content).hexdigest()
            artifacts.setdefault(digest, content)
            index[url] = f"artifacts/{digest}.tgz"
        npm_cache: Path | None = None
        bun_cache: Path | None = None
        temporary: tempfile.TemporaryDirectory | None = None
        if isinstance(lock, FetchedCandidate):
            temporary = tempfile.TemporaryDirectory(prefix="alloy-package-fetch-")
            scratch = Path(temporary.name)
            with tarfile.open(lock.archive.path, mode="r:*") as archive:
                roots = {member.name.split("/", 1)[0] for member in archive.getmembers() if member.name}
                if len(roots) != 1:
                    raise RuntimeError("candidate archive must have one top-level directory")
                archive.extractall(scratch, filter="data")
            source = scratch / next(iter(roots))
            npm_cache = scratch / "npm-cache"
            bun_cache = scratch / "bun-cache"
            home = scratch / "home"
            home.mkdir()
            npm = shutil.which("npm")
            bun = shutil.which("bun")
            if npm is None or bun is None:
                raise RuntimeError("trusted package fetch requires npm and Bun 1.3.14")
            environment = {
                "HOME": str(home),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": os.pathsep.join(dict.fromkeys((
                    str(Path(npm).parent), str(Path(bun).parent), "/usr/bin", "/bin"
                ))),
                "npm_config_userconfig": "/dev/null",
            }
            version = subprocess.run(
                [bun, "--version"], check=True, capture_output=True, text=True,
                env=environment,
            ).stdout.strip()
            if version != "1.3.14":
                raise RuntimeError("trusted package fetch requires Bun 1.3.14")
            subprocess.run(
                [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", str(npm_cache)],
                cwd=source, check=True, capture_output=True, text=True, env=environment,
            )
            subprocess.run(
                [
                    bun, "install", "--ignore-scripts", "--frozen-lockfile", "--production",
                    "--cache-dir", str(bun_cache),
                ],
                cwd=source / "tui", check=True, capture_output=True, text=True, env=environment,
            )

        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            for name, content in sorted(artifacts.items()):
                member = tarfile.TarInfo(f"artifacts/{name}.tgz")
                member.mode = 0o444
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            encoded = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()
            member = tarfile.TarInfo("index.json")
            member.mode = 0o444
            member.size = len(encoded)
            archive.addfile(member, io.BytesIO(encoded))
            for cache_name, cache_path in (("npm", npm_cache), ("bun", bun_cache)):
                if cache_path is not None:
                    archive.add(cache_path, arcname=cache_name, recursive=True)
        digest = hashlib.sha256(lock_bytes).hexdigest()
        try:
            return self._publish(f"npm-cache-{digest}.tar", output.getvalue())
        finally:
            if temporary is not None:
                temporary.cleanup()

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
        try:
            with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as archive:
                members = archive.getmembers()
                if not members or any(
                    Path(member.name).is_absolute()
                    or ".." in Path(member.name).parts
                    or not (member.isdir() or member.isreg())
                    for member in members
                ):
                    raise RuntimeError("target source archive contains unsafe paths")
        except tarfile.TarError as error:
            raise RuntimeError("target source archive is invalid") from error
        return self._publish(f"astropy-{profile.base_commit}.tar", content)
