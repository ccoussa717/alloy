import base64
import copy
import dataclasses
import hashlib
import io
import json
import os
import shlex
import subprocess
import tarfile
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from benchmarks.swebench.authority import VerifiedCandidate
from benchmarks.swebench.containers import ContainerHandle
from benchmarks.swebench.fetch import ArtifactFetcher
from benchmarks.swebench.install import (
    FetchedCandidate,
    ResourceCleanupUncertainError,
    VerifiedArtifact,
    install_candidate,
    prepare_target,
)
from benchmarks.swebench.profile import load_profile


REPO_ROOT = Path(__file__).parents[3]
PROFILE = load_profile(Path(__file__).parents[1] / "profile.json", REPO_ROOT)
SHA = "a" * 40
IMAGE_ID = "sha256:" + "b" * 64


class RecordingRuntime:
    def __init__(self, probe=None, *, wait_status=0, volume_cleanup_error=None):
        self.profile = PROFILE
        self.authority_root = REPO_ROOT
        self.probe = probe
        self.wait_status = wait_status
        self.volume_cleanup_error = volume_cleanup_error
        self.specs = []
        self.volumes = []
        self.initialized_volumes = []
        self.removed_volumes = []
        self.removed = []

    def verify_local_image(self, image):
        return IMAGE_ID

    def create_volume(self, name, run_id):
        self.volumes.append((name, run_id))

    def initialize_volume(self, name, target, run_id, image, image_id):
        self.initialized_volumes.append((name, target, run_id, image, image_id))

    def remove_volume(self, name, run_id):
        if self.volume_cleanup_error is not None:
            raise self.volume_cleanup_error
        self.removed_volumes.append((name, run_id))

    def create(self, spec):
        self.specs.append(spec)
        return ContainerHandle(spec.name, f"container-{len(self.specs)}", spec.run_id)

    def wait(self, handle, *, timeout=None):
        return self.wait_status

    def read_json(self, volume, path, *, limit):
        return self.probe

    def force_remove(self, handle):
        self.removed.append(handle)


def artifact(path, content):
    path.write_bytes(content)
    return VerifiedArtifact(path, hashlib.sha256(content).hexdigest(), len(content))


class ArtifactFetcherTests(unittest.TestCase):
    @staticmethod
    def _package_tar(content=b"module.exports = 1\n"):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            member = tarfile.TarInfo("package/index.js")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        return output.getvalue()

    def test_candidate_archive_is_verified_against_exact_git_tree_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
            package = {
                "name": "alloy-agent",
                "version": "1.1.26",
                "alloy": {"piFork": {"version": "0.82.1"}},
            }
            (repository / "package.json").write_text(json.dumps(package) + "\n")
            (repository / "npm-shrinkwrap.json").write_text(
                json.dumps({"lockfileVersion": 3, "packages": {}}) + "\n"
            )
            (repository / "tui").mkdir()
            (repository / "tui" / "bun.lock").write_text(
                json.dumps({"packages": {}}) + "\n"
            )
            (repository / "install.sh").write_text("#!/bin/sh\n")
            (repository / "install.sh").chmod(0o755)
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repository, check=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repository, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            archive = subprocess.run(
                ["git", "archive", "--format=tar", "--prefix=alloy-fixture/", commit],
                cwd=repository, check=True, capture_output=True,
            ).stdout

            fetcher = ArtifactFetcher(
                repository,
                repository / ".cache",
                downloader=lambda url: archive,
                profile=PROFILE,
            )
            fetched = fetcher.fetch_candidate(
                VerifiedCandidate(commit, commit, "1.1.26", ())
            )

            self.assertEqual(fetched.commit, commit)
            self.assertEqual(fetched.alloy_version, "1.1.26")
            self.assertEqual(fetched.pi_version, "0.82.1")
            self.assertEqual(fetched.archive.sha256, hashlib.sha256(archive).hexdigest())
            self.assertEqual(fetched.lock_sha256, hashlib.sha256(
                (repository / "npm-shrinkwrap.json").read_bytes()
            ).hexdigest())
            self.assertEqual(fetcher.requested_urls, [
                f"https://codeload.github.com/ccoussa717/alloy/tar.gz/{commit}"
            ])

    def test_fetch_rejects_wrong_tree_and_non_allowlisted_package_origins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
            (repository / "file").write_text("trusted\n")
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repository, check=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repository, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                content = b"attacker\n"
                member = tarfile.TarInfo("alloy-fixture/file")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            fetcher = ArtifactFetcher(
                repository, repository / ".cache", downloader=lambda url: stream.getvalue(),
                profile=PROFILE,
            )
            with self.assertRaisesRegex(RuntimeError, "Git tree"):
                fetcher.fetch_candidate(VerifiedCandidate(commit, commit, "1.1.26", ()))

            lock = {"packages": {"node_modules/evil": {
                "resolved": "https://attacker.invalid/evil.tgz",
                "integrity": "sha512-" + "AA==",
            }}}
            with self.assertRaisesRegex(RuntimeError, "allowlisted HTTPS origin"):
                fetcher.fetch_npm_cache(json.dumps(lock).encode())

    def test_archive_rejects_duplicate_paths_and_profile_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
            (repository / "file").write_text("x")
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repository, check=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repository, check=True,
                capture_output=True, text=True,
            ).stdout.strip()

            duplicate = io.BytesIO()
            with tarfile.open(fileobj=duplicate, mode="w") as archive:
                for _ in range(2):
                    member = tarfile.TarInfo("root/file")
                    member.size = 1
                    archive.addfile(member, io.BytesIO(b"x"))
            fetcher = ArtifactFetcher(
                repository, repository / ".cache", downloader=lambda url: duplicate.getvalue(),
                profile=PROFILE,
            )
            with self.assertRaisesRegex(RuntimeError, "duplicate"):
                fetcher.fetch_candidate(VerifiedCandidate(commit, commit, "1.1.26", ()))

            tiny_limits = dataclasses.replace(PROFILE.limits, max_file_bytes=1)
            tiny_profile = dataclasses.replace(PROFILE, limits=tiny_limits)
            oversized = io.BytesIO()
            with tarfile.open(fileobj=oversized, mode="w") as archive:
                member = tarfile.TarInfo("root/file")
                member.size = 2
                archive.addfile(member, io.BytesIO(b"xx"))
            bounded = ArtifactFetcher(
                repository, repository / ".bounded", downloader=lambda url: oversized.getvalue(),
                profile=tiny_profile,
            )
            with self.assertRaisesRegex(RuntimeError, "per-file"):
                bounded.fetch_candidate(VerifiedCandidate(commit, commit, "1.1.26", ()))

    def test_target_archive_matches_pinned_tree_and_rejects_dot_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            authority = root / "authority"
            target = root / "target"
            authority.mkdir()
            target.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=target, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=target, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=target, check=True)
            (target / "source.py").write_text("value = 1\n")
            subprocess.run(["git", "add", "."], cwd=target, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=target, check=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=target, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            profile = dataclasses.replace(
                PROFILE, dataset=dataclasses.replace(PROFILE.dataset, base_commit=commit),
            )
            archive = subprocess.run(
                ["git", "archive", "--format=tar", "--prefix=astropy-fixture/", commit],
                cwd=target, check=True, capture_output=True,
            ).stdout
            fetcher = ArtifactFetcher(
                authority, authority / ".cache", downloader=lambda url: archive,
                profile=profile, target_repository=target,
            )
            fetched = fetcher.fetch_target_source(profile)
            canonical = subprocess.run(
                ["git", "archive", "--format=tar", f"--prefix=astropy-{commit}/", commit],
                cwd=target, check=True, capture_output=True,
            ).stdout
            self.assertEqual(fetched.sha256, hashlib.sha256(canonical).hexdigest())

            hostile = io.BytesIO()
            with tarfile.open(fileobj=hostile, mode="w") as output:
                member = tarfile.TarInfo("astropy-fixture/.git/config")
                member.size = 5
                output.addfile(member, io.BytesIO(b"evil\n"))
            rejected = ArtifactFetcher(
                authority, authority / ".hostile", downloader=lambda url: hostile.getvalue(),
                profile=profile, target_repository=target,
            )
            with self.assertRaisesRegex(RuntimeError, r"\.git"):
                rejected.fetch_target_source(profile)

    def test_offline_cache_enumerates_npm_and_bun_locks_without_host_package_managers(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            repository.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repository, check=True)
            npm_bytes = self._package_tar(b"npm\n")
            bun_bytes = self._package_tar(b"bun\n")
            npm_url = "https://registry.npmjs.org/example/-/example-1.0.0.tgz"
            bun_url = "https://registry.npmjs.org/bun-example/-/bun-example-2.0.0.tgz"
            npm_integrity = "sha512-" + base64.b64encode(hashlib.sha512(npm_bytes).digest()).decode()
            bun_integrity = "sha512-" + base64.b64encode(hashlib.sha512(bun_bytes).digest()).decode()
            package = {
                "name": "alloy-agent", "version": "1.1.26",
                "alloy": {"piFork": {"version": "0.82.1"}},
            }
            lock = {
                "lockfileVersion": 3,
                "packages": {"node_modules/example": {
                    "resolved": npm_url, "integrity": npm_integrity,
                }},
            }
            bun_lock = {
                "lockfileVersion": 1,
                "configVersion": 1,
                "workspaces": {},
                "packages": {"bun-example": [
                    "bun-example@2.0.0", "", {}, bun_integrity,
                ]},
            }
            (repository / "tui").mkdir()
            (repository / "package.json").write_text(json.dumps(package) + "\n")
            (repository / "npm-shrinkwrap.json").write_text(json.dumps(lock) + "\n")
            (repository / "tui" / "bun.lock").write_text(json.dumps(bun_lock) + "\n")
            (repository / "install.sh").write_text("#!/bin/sh\n")
            (repository / "install.sh").chmod(0o755)
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repository, check=True)
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=repository, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            candidate_archive = subprocess.run(
                ["git", "archive", "--format=tar", "--prefix=alloy-fixture/", commit],
                cwd=repository, check=True, capture_output=True,
            ).stdout
            downloads = {
                f"https://codeload.github.com/ccoussa717/alloy/tar.gz/{commit}": candidate_archive,
                npm_url: npm_bytes,
                bun_url: bun_bytes,
            }
            fetcher = ArtifactFetcher(
                repository, repository / ".cache", downloader=downloads.__getitem__, profile=PROFILE,
            )
            fetched = fetcher.fetch_candidate(VerifiedCandidate(commit, commit, "1.1.26", ()))

            with mock.patch("benchmarks.swebench.fetch.subprocess.run") as run:
                cache = fetcher.fetch_npm_cache(fetched)
            run.assert_not_called()

            with tarfile.open(cache.path) as archive:
                names = set(archive.getnames())
                metadata = json.load(archive.extractfile("cache-metadata.json"))
            self.assertIn("npm/index.json", names)
            self.assertIn("bun/bun-example@2.0.0@@@1/index.js", names)
            self.assertEqual(metadata["npm_lock_sha256"], fetched.lock_sha256)
            self.assertEqual(metadata["bun_lock_sha256"], fetched.bun_lock_sha256)
            self.assertEqual(set(metadata["artifacts"]), {npm_url, bun_url})


class CandidateInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        npm_lock = b'{"packages":{}}\n'
        bun_lock = b'{"packages":{}}\n'
        self.fetched = FetchedCandidate(
            commit=SHA,
            alloy_version="1.1.26",
            pi_version="0.82.1",
            archive=artifact(root / "candidate.tar", b"candidate"),
            npm_cache=artifact(root / "npm-cache.tar", b"npm-cache"),
            bun_archive=artifact(root / "bun.zip", b"bun"),
            lock_sha256=hashlib.sha256(npm_lock).hexdigest(),
            bun_lock_sha256=hashlib.sha256(bun_lock).hexdigest(),
            lock=npm_lock,
            bun_lock=bun_lock,
        )
        self.probe = {
            "alloy_version": "1.1.26",
            "pi_version": "0.82.1",
            "commit": SHA,
            "archive_sha256": self.fetched.archive.sha256,
            "lock_sha256": self.fetched.lock_sha256,
            "bun_lock_sha256": self.fetched.bun_lock_sha256,
            "cache_sha256": self.fetched.npm_cache.sha256,
            "bun_sha256": self.fetched.bun_archive.sha256,
            "network_ipv4": "blocked",
            "network_ipv6": "blocked",
            "manifest": {
                "channel": "main",
                "commit": SHA,
                "ref": SHA,
                "repository": "ccoussa717/alloy",
                "version": "1.1.26",
            },
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_install_is_networkless_and_mounts_only_verified_artifacts_and_output(self):
        runtime = RecordingRuntime(self.probe)
        installed = install_candidate(runtime, self.fetched, PROFILE, run_id="run-123")

        self.assertEqual(installed.image_id, IMAGE_ID)
        self.assertEqual(installed.alloy_version, "1.1.26")
        self.assertEqual(installed.pi_version, "0.82.1")
        self.assertEqual(installed.commit, SHA)
        self.assertEqual(installed.archive_sha256, self.fetched.archive.sha256)
        self.assertEqual(installed.cache_sha256, self.fetched.npm_cache.sha256)
        frozen = installed.app_mount()
        self.assertEqual((frozen.source, frozen.read_only, frozen.kind), (
            installed.app_volume, True, "volume"
        ))
        self.assertEqual(runtime.volumes, [(installed.app_volume, "run-123")])
        self.assertEqual(runtime.initialized_volumes, [(
            installed.app_volume, "/output", "run-123", PROFILE.agent_image, IMAGE_ID,
        )])
        self.assertEqual(len(runtime.specs), 1)
        spec = runtime.specs[0]
        self.assertEqual(spec.network_mode, "none")
        self.assertEqual(spec.image, PROFILE.agent_image)
        self.assertEqual(spec.image_id, IMAGE_ID)
        self.assertEqual(
            [(mount.target, mount.read_only, mount.kind) for mount in spec.mounts],
            [
                ("/input/candidate.tar", True, "bind"),
                ("/input/npm-cache.tar", True, "bind"),
                ("/input/bun.zip", True, "bind"),
                ("/output", False, "volume"),
            ],
        )
        forbidden = ("key", "result", "docker.sock", "dataset", "coordinator", "authority")
        mounted = " ".join(f"{mount.source} {mount.target}" for mount in spec.mounts).lower()
        for token in forbidden:
            self.assertNotIn(token, mounted)
        self.assertEqual(runtime.removed[0].container_id, "container-1")
        self.assertEqual(runtime.removed_volumes, [])

    def test_install_rechecks_artifact_digest_before_any_container_action(self):
        self.fetched.archive.path.chmod(0o644)
        self.fetched.archive.path.write_bytes(b"changed")
        runtime = RecordingRuntime(self.probe)
        with self.assertRaisesRegex(RuntimeError, "artifact drifted"):
            install_candidate(runtime, self.fetched, PROFILE, run_id="run-drifted-artifact")
        self.assertEqual(runtime.volumes, [])
        self.assertEqual(runtime.specs, [])

    def test_install_rejects_probe_metadata_drift_after_container_teardown(self):
        runtime = RecordingRuntime(probe={**self.probe, "alloy_version": "9.9.9"})
        with self.assertRaisesRegex(RuntimeError, "probe metadata"):
            install_candidate(runtime, self.fetched, PROFILE, run_id="run-drift")
        self.assertEqual(len(runtime.removed), 1)
        self.assertEqual(runtime.removed_volumes, [("alloy-app-run-drift", "run-drift")])

    def test_install_rejects_every_artifact_lock_network_and_manifest_drift(self):
        changes = (
            (("archive_sha256",), "0" * 64),
            (("lock_sha256",), "0" * 64),
            (("bun_lock_sha256",), "0" * 64),
            (("cache_sha256",), "0" * 64),
            (("bun_sha256",), "0" * 64),
            (("network_ipv4",), "open"),
            (("network_ipv6",), "open"),
            (("manifest", "channel"), "stable"),
            (("manifest", "ref"), "main"),
            (("manifest", "repository"), "attacker/repo"),
        )
        for index, (path, value) in enumerate(changes):
            probe = copy.deepcopy(self.probe)
            target = probe
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            runtime = RecordingRuntime(probe)
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "probe metadata"):
                install_candidate(runtime, self.fetched, PROFILE, run_id=f"run-bound-{index}")
            self.assertEqual(runtime.removed_volumes, [
                (f"alloy-app-run-bound-{index}", f"run-bound-{index}"),
            ])

    def test_install_failure_removes_partial_volume_and_preserves_cleanup_uncertainty(self):
        cleanup = RuntimeError("volume daemon unavailable")
        runtime = RecordingRuntime(
            self.probe, wait_status=17, volume_cleanup_error=cleanup,
        )
        with self.assertRaises(ResourceCleanupUncertainError) as raised:
            install_candidate(runtime, self.fetched, PROFILE, run_id="run-failed")
        self.assertRegex(str(raised.exception.original_error), "status 17")
        self.assertIs(raised.exception.cleanup_error, cleanup)
        self.assertEqual(len(runtime.removed), 1)

    def test_fake_installer_sentinel_and_network_probes_are_confined_to_volume(self):
        host_sentinel = Path(self.temporary.name) / "host-sentinel"
        runtime = RecordingRuntime(self.probe)
        install_candidate(runtime, self.fetched, PROFILE, run_id="run-probe")
        command = "\n".join(runtime.specs[0].command)
        self.assertIn("/output/sentinel", command)
        self.assertIn("network_ipv4=blocked", command)
        self.assertIn("network_ipv6=blocked", command)
        self.assertFalse(host_sentinel.exists())

    def test_target_setup_uses_evaluator_image_and_fresh_agent_volume(self):
        runtime = RecordingRuntime(self.probe)
        source = artifact(Path(self.temporary.name) / "target.tar", b"target")
        prepared = prepare_target(runtime, source, PROFILE, run_id="run-target")

        self.assertNotEqual(prepared.agent_volume, "alloy-app-run-target")
        self.assertEqual(runtime.volumes, [(prepared.agent_volume, "run-target")])
        self.assertEqual(runtime.initialized_volumes, [(
            prepared.agent_volume, "/agent-work", "run-target", PROFILE.evaluator_image, IMAGE_ID,
        )])
        self.assertEqual(len(runtime.specs), 1)
        spec = runtime.specs[0]
        self.assertEqual(spec.image, PROFILE.evaluator_image)
        self.assertEqual(spec.network_mode, "none")
        self.assertEqual(
            [(mount.target, mount.read_only, mount.kind) for mount in spec.mounts],
            [("/input/target.tar", True, "bind"), ("/agent-work", False, "volume")],
        )

    def test_target_failure_removes_partial_agent_volume(self):
        runtime = RecordingRuntime(self.probe, wait_status=23)
        source = artifact(Path(self.temporary.name) / "target-failed.tar", b"target")
        with self.assertRaisesRegex(RuntimeError, "status 23"):
            prepare_target(runtime, source, PROFILE, run_id="run-target-failed")
        self.assertEqual(runtime.removed_volumes, [(
            "alloy-agent-work-run-target-failed", "run-target-failed",
        )])


class HostileDockerInstallTests(unittest.TestCase):
    def test_hostile_installer_writes_only_volume_as_nonroot_and_has_no_ip_egress(self):
        if os.environ.get("ALLOY_SWEBENCH_REQUIRE_DOCKER") != "1":
            self.skipTest("set ALLOY_SWEBENCH_REQUIRE_DOCKER=1 for required Docker isolation")
        docker = "/usr/bin/docker"
        endpoint = "unix:///var/run/docker.sock"
        image = "node:22-bookworm"
        inspected = subprocess.run(
            [docker, "--host", endpoint, "image", "inspect", image, "--format", "{{.Id}}"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        self.assertRegex(inspected, r"^sha256:[0-9a-f]{64}$")
        run_id = "hostile-" + uuid.uuid4().hex
        volume = "alloy-hostile-" + uuid.uuid4().hex
        host_root = Path(tempfile.mkdtemp(prefix="alloy-hostile-host-"))
        host_sentinel = host_root / "sentinel"
        fake_installer = host_root / "install.sh"
        policy = REPO_ROOT / PROFILE.security_policy.seccomp_path
        security = [
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--security-opt", f"seccomp={policy}",
            "--read-only", "--network", "none",
        ]
        subprocess.run(
            [docker, "--host", endpoint, "volume", "create", "--label", f"alloy.swebench.gate={run_id}", volume],
            check=True, capture_output=True, text=True,
        )
        try:
            subprocess.run(
                [
                    docker, "--host", endpoint, "run", "--rm", *security,
                    "--user", "0:0", "--cap-add", "CHOWN",
                    "--mount", f"type=volume,src={volume},dst=/output",
                    inspected, "/bin/sh", "-euc", "chown 65532:65532 /output",
                ],
                check=True, capture_output=True, text=True, timeout=60,
            )
            script = r"""
const fs = require('node:fs');
const net = require('node:net');
fs.writeFileSync('/output/sentinel', 'volume-only\n');
function blocked(host, family) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host, port: 9, family});
    const timer = setTimeout(() => { socket.destroy(); resolve('blocked'); }, 1000);
    socket.on('connect', () => { clearTimeout(timer); reject(new Error(`egress reached ${host}`)); });
    socket.on('error', () => { clearTimeout(timer); resolve('blocked'); });
  });
}
Promise.all([blocked('1.1.1.1', 4), blocked('2606:4700:4700::1111', 6)])
  .then(([ipv4, ipv6]) => fs.writeFileSync('/output/network.json', JSON.stringify({ipv4, ipv6, uid: process.getuid()})))
  .catch((error) => { console.error(error); process.exit(1); });
"""
            fake_installer.write_text(
                "#!/bin/sh\nset -eu\nexec /usr/local/bin/node -e " + shlex.quote(script) + "\n"
            )
            fake_installer.chmod(0o555)
            subprocess.run(
                [
                    docker, "--host", endpoint, "run", "--rm", *security,
                    "--user", "65532:65532",
                    "--mount", f"type=bind,src={fake_installer},dst=/input/install.sh,readonly",
                    "--mount", f"type=volume,src={volume},dst=/output",
                    inspected, "/bin/sh", "/input/install.sh",
                ],
                check=True, capture_output=True, text=True, timeout=60,
            )
            result = subprocess.run(
                [
                    docker, "--host", endpoint, "run", "--rm", *security,
                    "--user", "0:0",
                    "--mount", f"type=volume,src={volume},dst=/output,readonly",
                    inspected, "/bin/sh", "-euc", "cat /output/sentinel; cat /output/network.json",
                ],
                check=True, capture_output=True, text=True, timeout=60,
            )
            lines = result.stdout.splitlines()
            self.assertEqual(lines[0], "volume-only")
            self.assertEqual(json.loads(lines[1]), {"ipv4": "blocked", "ipv6": "blocked", "uid": 65532})
            self.assertFalse(host_sentinel.exists())
        finally:
            subprocess.run(
                [docker, "--host", endpoint, "volume", "rm", volume],
                check=True, capture_output=True, text=True,
            )
            fake_installer.unlink(missing_ok=True)
            host_root.rmdir()


if __name__ == "__main__":
    unittest.main()
