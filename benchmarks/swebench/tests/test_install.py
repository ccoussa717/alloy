import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from benchmarks.swebench.authority import VerifiedCandidate
from benchmarks.swebench.containers import ContainerHandle
from benchmarks.swebench.fetch import ArtifactFetcher
from benchmarks.swebench.install import (
    FetchedCandidate,
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
    def __init__(self, probe=None):
        self.profile = PROFILE
        self.authority_root = REPO_ROOT
        self.probe = probe or {
            "alloy_version": "1.1.26",
            "pi_version": "0.82.1",
            "commit": SHA,
        }
        self.specs = []
        self.volumes = []
        self.removed = []

    def verify_local_image(self, image):
        return IMAGE_ID

    def create_volume(self, name, run_id):
        self.volumes.append((name, run_id))

    def create(self, spec):
        self.specs.append(spec)
        return ContainerHandle(spec.name, f"container-{len(self.specs)}", spec.run_id)

    def wait(self, handle, *, timeout=None):
        return 0

    def read_json(self, volume, path, *, limit):
        return self.probe

    def force_remove(self, handle):
        self.removed.append(handle)


def artifact(path, content):
    path.write_bytes(content)
    return VerifiedArtifact(path, hashlib.sha256(content).hexdigest(), len(content))


class ArtifactFetcherTests(unittest.TestCase):
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
            fetcher = ArtifactFetcher(repository, repository / ".cache", downloader=lambda url: stream.getvalue())
            with self.assertRaisesRegex(RuntimeError, "Git tree"):
                fetcher.fetch_candidate(VerifiedCandidate(commit, commit, "1.1.26", ()))

            lock = {"packages": {"node_modules/evil": {
                "resolved": "https://attacker.invalid/evil.tgz",
                "integrity": "sha512-" + "AA==",
            }}}
            with self.assertRaisesRegex(RuntimeError, "allowlisted HTTPS origin"):
                fetcher.fetch_npm_cache(json.dumps(lock).encode())


class CandidateInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.fetched = FetchedCandidate(
            commit=SHA,
            alloy_version="1.1.26",
            pi_version="0.82.1",
            archive=artifact(root / "candidate.tar", b"candidate"),
            npm_cache=artifact(root / "npm-cache.tar", b"npm-cache"),
            bun_archive=artifact(root / "bun.zip", b"bun"),
            lock_sha256="c" * 64,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_install_is_networkless_and_mounts_only_verified_artifacts_and_output(self):
        runtime = RecordingRuntime()
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

    def test_install_rechecks_artifact_digest_before_any_container_action(self):
        self.fetched.archive.path.chmod(0o644)
        self.fetched.archive.path.write_bytes(b"changed")
        runtime = RecordingRuntime()
        with self.assertRaisesRegex(RuntimeError, "artifact drifted"):
            install_candidate(runtime, self.fetched, PROFILE, run_id="run-drifted-artifact")
        self.assertEqual(runtime.volumes, [])
        self.assertEqual(runtime.specs, [])

    def test_install_rejects_probe_metadata_drift_after_container_teardown(self):
        runtime = RecordingRuntime(probe={
            "alloy_version": "9.9.9", "pi_version": "0.82.1", "commit": SHA,
        })
        with self.assertRaisesRegex(RuntimeError, "probe metadata"):
            install_candidate(runtime, self.fetched, PROFILE, run_id="run-drift")
        self.assertEqual(len(runtime.removed), 1)

    def test_fake_installer_sentinel_and_network_probes_are_confined_to_volume(self):
        host_sentinel = Path(self.temporary.name) / "host-sentinel"
        runtime = RecordingRuntime()
        install_candidate(runtime, self.fetched, PROFILE, run_id="run-probe")
        command = "\n".join(runtime.specs[0].command)
        self.assertIn("/output/sentinel", command)
        self.assertIn("network_ipv4=blocked", command)
        self.assertIn("network_ipv6=blocked", command)
        self.assertFalse(host_sentinel.exists())

    def test_target_setup_uses_evaluator_image_and_fresh_agent_volume(self):
        runtime = RecordingRuntime()
        source = artifact(Path(self.temporary.name) / "target.tar", b"target")
        prepared = prepare_target(runtime, source, PROFILE, run_id="run-target")

        self.assertNotEqual(prepared.agent_volume, "alloy-app-run-target")
        self.assertEqual(runtime.volumes, [(prepared.agent_volume, "run-target")])
        self.assertEqual(len(runtime.specs), 1)
        spec = runtime.specs[0]
        self.assertEqual(spec.image, PROFILE.evaluator_image)
        self.assertEqual(spec.network_mode, "none")
        self.assertEqual(
            [(mount.target, mount.read_only, mount.kind) for mount in spec.mounts],
            [("/input/target.tar", True, "bind"), ("/agent-work", False, "volume")],
        )


if __name__ == "__main__":
    unittest.main()
