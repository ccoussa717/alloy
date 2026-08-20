from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from benchmarks.swebench.containers import ContainerSpec, DockerRuntime, MountSpec
from benchmarks.swebench.profile import BenchmarkProfile


SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class VerifiedArtifact:
    path: Path
    sha256: str
    size: int

    def __post_init__(self) -> None:
        path = self.path.resolve()
        if not path.is_file() or self.path.is_symlink():
            raise ValueError("verified artifact must be a regular non-symlink file")
        if SHA256.fullmatch(self.sha256) is None or self.size <= 0:
            raise ValueError("verified artifact digest and size are invalid")
        object.__setattr__(self, "path", path)

    def verify(self) -> None:
        try:
            metadata = os.lstat(self.path)
            content = self.path.read_bytes()
        except OSError as error:
            raise RuntimeError("verified artifact is unavailable") from error
        if (
            self.path.is_symlink()
            or not self.path.is_file()
            or metadata.st_size != self.size
            or hashlib.sha256(content).hexdigest() != self.sha256
        ):
            raise RuntimeError("verified artifact drifted before container launch")


@dataclass(frozen=True)
class FetchedCandidate:
    commit: str
    alloy_version: str
    pi_version: str
    archive: VerifiedArtifact
    lock_sha256: str
    bun_lock_sha256: str = ""
    npm_cache: VerifiedArtifact | None = None
    bun_archive: VerifiedArtifact | None = None
    lock: bytes = b""
    bun_lock: bytes = b""


@dataclass(frozen=True)
class VerifiedCandidateInstall:
    image_id: str
    alloy_version: str
    pi_version: str
    commit: str
    app_volume: str
    archive_sha256: str
    cache_sha256: str
    bun_sha256: str

    def app_mount(self, target: str = "/opt/alloy") -> MountSpec:
        return MountSpec(self.app_volume, target, True, "volume")


@dataclass(frozen=True)
class PreparedTarget:
    image_id: str
    base_commit: str
    source_sha256: str
    agent_volume: str


class ResourceCleanupUncertainError(RuntimeError):
    def __init__(self, resource: str, original_error: BaseException, cleanup_error: BaseException) -> None:
        self.resource = resource
        self.original_error = original_error
        self.cleanup_error = cleanup_error
        super().__init__(
            f"cleanup uncertain for {resource}; original failure: {original_error}; "
            f"cleanup failure: {cleanup_error}"
        )


def _volume(runtime: DockerRuntime, name: str, run_id: str) -> None:
    create_volume = getattr(runtime, "create_volume", None)
    if create_volume is not None:
        create_volume(name, run_id)
        return
    inspected = runtime._run(
        runtime._docker_arguments("volume", "inspect", name), check=False
    )
    if inspected.returncode == 0:
        raise RuntimeError("refusing to reuse an existing Docker volume")
    if "No such volume" not in inspected.stderr:
        raise RuntimeError("could not prove Docker volume absence")
    runtime._run(runtime._docker_arguments(
        "volume", "create", "--label", f"alloy.swebench.gate={run_id}", name
    ))


def _initialize_volume(
    runtime: DockerRuntime,
    name: str,
    target: str,
    run_id: str,
    image: object,
    image_id: str,
) -> None:
    initialize = getattr(runtime, "initialize_volume", None)
    if initialize is None:
        raise RuntimeError("Docker runtime does not provide confined volume initialization")
    initialize(name, target, run_id, image, image_id)


def _remove_volume(runtime: DockerRuntime, name: str, run_id: str) -> None:
    remove = getattr(runtime, "remove_volume", None)
    if remove is None:
        raise RuntimeError("Docker runtime does not provide verified volume cleanup")
    remove(name, run_id)


def _logs(runtime: DockerRuntime, container_id: str) -> dict[str, object]:
    read_json = getattr(runtime, "read_json", None)
    if read_json is not None:
        value = read_json("", "/output/probe.json", limit=4096)
    else:
        result = runtime._run(runtime._docker_arguments("logs", container_id))
        try:
            value = json.loads(result.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise RuntimeError("candidate probe output is missing or invalid") from error
    if not isinstance(value, dict):
        raise RuntimeError("candidate probe output must be a JSON object")
    return value


INSTALL_SCRIPT = r"""
set -euo pipefail
mkdir -p /output/{home,zdotdir,config,cache,data,state,runtime,tmp,prefix}
mkdir -p /output/input /output/npm-cache /output/shims
export OBSERVED_ARCHIVE_SHA256="$(sha256sum /input/candidate.tar | cut -d' ' -f1)"
export OBSERVED_CACHE_SHA256="$(sha256sum /input/npm-cache.tar | cut -d' ' -f1)"
export OBSERVED_BUN_SHA256="$(sha256sum /input/bun.zip | cut -d' ' -f1)"
tar -xf /input/candidate.tar -C /output/input --strip-components=1
tar -xf /input/npm-cache.tar -C /output/npm-cache
export OBSERVED_LOCK_SHA256="$(sha256sum /output/input/npm-shrinkwrap.json | cut -d' ' -f1)"
export OBSERVED_BUN_LOCK_SHA256="$(sha256sum /output/input/tui/bun.lock | cut -d' ' -f1)"
export CACHE_NPM_LOCK_SHA256="$(/usr/local/bin/node -p 'JSON.parse(require("fs").readFileSync("/output/npm-cache/cache-metadata.json")).npm_lock_sha256')"
export CACHE_BUN_LOCK_SHA256="$(/usr/local/bin/node -p 'JSON.parse(require("fs").readFileSync("/output/npm-cache/cache-metadata.json")).bun_lock_sha256')"
test "$CACHE_NPM_LOCK_SHA256" = "$OBSERVED_LOCK_SHA256"
test "$CACHE_BUN_LOCK_SHA256" = "$OBSERVED_BUN_LOCK_SHA256"
cat > /output/shims/curl <<'CURL'
#!/bin/bash
set -euo pipefail
output=''
url=''
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
expected="https://codeload.github.com/ccoussa717/alloy/tar.gz/$CANDIDATE_COMMIT"
test -n "$output" && test "$url" = "$expected"
cp /input/candidate.tar "$output"
CURL
chmod 0555 /output/shims/curl
cat > /output/shims/npm <<'NPM'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == ci ]]; then
  /usr/local/bin/node - /output/npm-cache/index.json npm-shrinkwrap.json <<'NODE'
const fs = require('node:fs');
const index = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lockPath = process.argv[3];
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
for (const pkg of Object.values(lock.packages || {})) {
  if (pkg && typeof pkg.resolved === 'string') {
    const local = index[pkg.resolved];
    if (!local) throw new Error(`missing verified artifact for ${pkg.resolved}`);
    pkg.resolved = `/output/npm-cache/${local}`;
  }
}
fs.writeFileSync(lockPath, JSON.stringify(lock));
NODE
fi
exec /usr/local/bin/npm "$@"
NPM
chmod 0555 /output/shims/npm
mkdir -p /output/data/alloy/bun-v1.3.14-linux-x64-baseline
unzip -q /input/bun.zip -d /output/tmp/bun
cp /output/tmp/bun/bun-linux-x64-baseline/bun /output/data/alloy/bun-v1.3.14-linux-x64-baseline/bun
chmod 0555 /output/data/alloy/bun-v1.3.14-linux-x64-baseline/bun
export HOME=/output/home ZDOTDIR=/output/zdotdir XDG_CONFIG_HOME=/output/config
export XDG_CACHE_HOME=/output/cache XDG_DATA_HOME=/output/data XDG_STATE_HOME=/output/state
export XDG_RUNTIME_DIR=/output/runtime TMPDIR=/output/tmp ALLOY_PREFIX=/output/prefix
export ALLOY_CHANNEL=main ALLOY_REF="$CANDIDATE_COMMIT" npm_config_offline=true
export npm_config_cache=/output/npm-cache/npm BUN_INSTALL_CACHE_DIR=/output/npm-cache/bun
export PATH="/output/shims:$PATH"
unset BASH_ENV ENV npm_config_proxy npm_config_https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
bash /output/input/install.sh
/output/prefix/bin/alloy --version > /output/version.txt
if /usr/local/bin/node -e "const s=require('net').connect(9,'1.1.1.1'); const t=setTimeout(()=>{s.destroy();process.exit(0)},1000); s.on('connect',()=>{clearTimeout(t);process.exit(1)}).on('error',()=>{clearTimeout(t);process.exit(0)})"; then network_ipv4=blocked; else exit 70; fi
if /usr/local/bin/node -e "const s=require('net').connect({port:9,host:'2606:4700:4700::1111',family:6}); const t=setTimeout(()=>{s.destroy();process.exit(0)},1000); s.on('connect',()=>{clearTimeout(t);process.exit(1)}).on('error',()=>{clearTimeout(t);process.exit(0)})"; then network_ipv6=blocked; else exit 71; fi
export NETWORK_IPV4="$network_ipv4" NETWORK_IPV6="$network_ipv6"
printf '%s\n' "network_ipv4=$network_ipv4 network_ipv6=$network_ipv6" >&2
/usr/local/bin/node - /output/data/alloy/app/package.json /output/data/alloy/install-manifest.json /output/version.txt <<'NODE'
const fs = require('node:fs');
const [pkgPath, manifestPath, versionPath] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = fs.readFileSync(versionPath, 'utf8');
const alloy = /^Alloy\s+(\S+)\s*$/m.exec(version)?.[1];
const pi = /^Pi\s+(\S+)\s*$/m.exec(version)?.[1];
const installedPi = pkg.alloy?.piFork?.version;
const allowedManifest = new Set(['channel', 'commit', 'installedAt', 'ref', 'repository', 'version']);
if (!alloy || !pi || pkg.version !== alloy || installedPi !== pi ||
    manifest.version !== alloy || manifest.commit !== process.env.CANDIDATE_COMMIT ||
    manifest.channel !== 'main' || manifest.ref !== process.env.CANDIDATE_COMMIT ||
    manifest.repository !== 'ccoussa717/alloy' ||
    process.env.CACHE_NPM_LOCK_SHA256 !== process.env.OBSERVED_LOCK_SHA256 ||
    process.env.CACHE_BUN_LOCK_SHA256 !== process.env.OBSERVED_BUN_LOCK_SHA256 ||
    Object.keys(manifest).some((key) => !allowedManifest.has(key))) {
  throw new Error('installed candidate metadata is inconsistent');
}
const probe = {
  alloy_version: alloy, pi_version: pi, commit: manifest.commit,
  archive_sha256: process.env.OBSERVED_ARCHIVE_SHA256,
  lock_sha256: process.env.OBSERVED_LOCK_SHA256,
  bun_lock_sha256: process.env.OBSERVED_BUN_LOCK_SHA256,
  cache_sha256: process.env.OBSERVED_CACHE_SHA256,
  bun_sha256: process.env.OBSERVED_BUN_SHA256,
  network_ipv4: process.env.NETWORK_IPV4, network_ipv6: process.env.NETWORK_IPV6,
  manifest: {
    channel: manifest.channel, commit: manifest.commit, ref: manifest.ref,
    repository: manifest.repository, version: manifest.version,
  },
};
fs.writeFileSync('/output/probe.json', JSON.stringify(probe));
process.stdout.write(JSON.stringify(probe) + '\n');
NODE
touch /output/sentinel
""".strip()


def install_candidate(
    runtime: DockerRuntime,
    fetched: FetchedCandidate,
    profile: BenchmarkProfile,
    *,
    run_id: str = "candidate-install",
) -> VerifiedCandidateInstall:
    if SAFE_ID.fullmatch(run_id) is None:
        raise ValueError("run ID must be safe for a Docker resource name")
    if runtime.profile != profile:
        raise ValueError("runtime profile does not match candidate install profile")
    if fetched.npm_cache is None or fetched.bun_archive is None:
        raise ValueError("candidate installation requires verified npm and Bun artifacts")
    if (
        SHA256.fullmatch(fetched.lock_sha256) is None
        or hashlib.sha256(fetched.lock).hexdigest() != fetched.lock_sha256
    ):
        raise ValueError("candidate npm lock SHA-256 is invalid")
    if (
        SHA256.fullmatch(fetched.bun_lock_sha256) is None
        or hashlib.sha256(fetched.bun_lock).hexdigest() != fetched.bun_lock_sha256
    ):
        raise ValueError("candidate Bun lock SHA-256 is invalid")
    for artifact in (fetched.archive, fetched.npm_cache, fetched.bun_archive):
        artifact.verify()
    image_id = runtime.verify_local_image(profile.agent_image)
    volume = f"alloy-app-{run_id}"
    volume_created = False
    try:
        _volume(runtime, volume, run_id)
        volume_created = True
        _initialize_volume(runtime, volume, "/output", run_id, profile.agent_image, image_id)
        mounts = (
            MountSpec(fetched.archive.path, "/input/candidate.tar", True, "bind"),
            MountSpec(fetched.npm_cache.path, "/input/npm-cache.tar", True, "bind"),
            MountSpec(fetched.bun_archive.path, "/input/bun.zip", True, "bind"),
            MountSpec(volume, "/output", False, "volume"),
        )
        spec = ContainerSpec(
            name=f"alloy-install-{run_id}", run_id=run_id, image=profile.agent_image,
            image_id=image_id, command=("/bin/bash", "-euc", INSTALL_SCRIPT), mounts=mounts,
            environment=(("CANDIDATE_COMMIT", fetched.commit),), network_mode="none",
        )
        handle = runtime.create(spec)
        try:
            status = runtime.wait(handle, timeout=profile.agent_timeout_seconds)
            if status != 0:
                raise RuntimeError(f"candidate installation exited with status {status}")
            probe = _logs(runtime, handle.container_id)
        finally:
            runtime.force_remove(handle)
        expected = {
            "alloy_version": fetched.alloy_version, "pi_version": fetched.pi_version,
            "commit": fetched.commit, "archive_sha256": fetched.archive.sha256,
            "lock_sha256": fetched.lock_sha256, "bun_lock_sha256": fetched.bun_lock_sha256,
            "cache_sha256": fetched.npm_cache.sha256, "bun_sha256": fetched.bun_archive.sha256,
            "network_ipv4": "blocked", "network_ipv6": "blocked",
            "manifest": {
                "channel": "main", "commit": fetched.commit, "ref": fetched.commit,
                "repository": "ccoussa717/alloy", "version": fetched.alloy_version,
            },
        }
        if probe != expected:
            raise RuntimeError("candidate probe metadata differs from trusted metadata")
        return VerifiedCandidateInstall(
            image_id, fetched.alloy_version, fetched.pi_version, fetched.commit, volume,
            fetched.archive.sha256, fetched.npm_cache.sha256, fetched.bun_archive.sha256,
        )
    except BaseException as original_error:
        if volume_created:
            try:
                _remove_volume(runtime, volume, run_id)
            except BaseException as cleanup_error:
                raise ResourceCleanupUncertainError(
                    volume, original_error, cleanup_error,
                ) from original_error
        raise


TARGET_SCRIPT = r"""
set -euo pipefail
test "$(git -C /testbed rev-parse HEAD)" = "$BASE_COMMIT"
tar -xf /input/target.tar -C /agent-work --strip-components=1
cp -a /testbed/.git /agent-work/.git
git -C /agent-work reset --hard "$BASE_COMMIT"
git -C /agent-work clean -ffdqx
test "$(git -C /agent-work rev-parse HEAD)" = "$BASE_COMMIT"
""".strip()


def prepare_target(
    runtime: DockerRuntime,
    source: VerifiedArtifact,
    profile: BenchmarkProfile,
    *,
    run_id: str = "target-setup",
) -> PreparedTarget:
    if SAFE_ID.fullmatch(run_id) is None:
        raise ValueError("run ID must be safe for a Docker resource name")
    if runtime.profile != profile:
        raise ValueError("runtime profile does not match target setup profile")
    source.verify()
    image_id = runtime.verify_local_image(profile.evaluator_image)
    volume = f"alloy-agent-work-{run_id}"
    volume_created = False
    try:
        _volume(runtime, volume, run_id)
        volume_created = True
        _initialize_volume(
            runtime, volume, "/agent-work", run_id, profile.evaluator_image, image_id,
        )
        spec = ContainerSpec(
            name=f"alloy-target-{run_id}", run_id=run_id, image=profile.evaluator_image,
            image_id=image_id, command=("/bin/bash", "-euc", TARGET_SCRIPT),
            mounts=(MountSpec(source.path, "/input/target.tar", True, "bind"),
                    MountSpec(volume, "/agent-work", False, "volume")),
            environment=(("BASE_COMMIT", profile.base_commit),), network_mode="none",
        )
        handle = runtime.create(spec)
        try:
            status = runtime.wait(handle, timeout=profile.evaluator_timeout_seconds)
            if status != 0:
                raise RuntimeError(f"target setup exited with status {status}")
        finally:
            runtime.force_remove(handle)
        return PreparedTarget(image_id, profile.base_commit, source.sha256, volume)
    except BaseException as original_error:
        if volume_created:
            try:
                _remove_volume(runtime, volume, run_id)
            except BaseException as cleanup_error:
                raise ResourceCleanupUncertainError(
                    volume, original_error, cleanup_error,
                ) from original_error
        raise
