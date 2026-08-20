import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from benchmarks.swebench.authority import (
    ReleaseTransformPolicy,
    coordinator_tree_digest,
    load_host_config,
    load_policy_from_commit,
    main,
    verify_candidate,
)


OLD_VERSION = "1.1.25"
NEW_VERSION = "1.1.26"
HOST_CONFIG_PATH = Path(__file__).parents[1] / "host-config.example.json"


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.repository = Path(self.temporary_directory.name)
        self._git("init", "-q")
        self._git("config", "user.name", "Release Test")
        self._git("config", "user.email", "release@example.com")
        self._write_authority_tree()
        self.authority = self._commit("authority")
        self.policy = ReleaseTransformPolicy(
            old_version=OLD_VERSION,
            new_version=NEW_VERSION,
            release_date="2026-08-19",
            json_pointers={
                "package.json": ("/version",),
                "tui/package.json": ("/version",),
                "npm-shrinkwrap.json": ("/version", "/packages//version"),
            },
            literals={
                "extensions/ui.ts": 1,
                "lib/child-runner.mjs": 1,
                "lib/mcp-client.mjs": 1,
            },
            changelog_path="CHANGELOG.md",
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def _git(self, *arguments, check=True):
        return subprocess.run(
            ["git", *arguments],
            cwd=self.repository,
            capture_output=True,
            text=True,
            check=check,
        )

    def _write(self, relative, content):
        path = self.repository / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def _write_authority_tree(self):
        self._write(
            "package.json",
            json.dumps(
                {"name": "alloy", "version": OLD_VERSION, "scripts": {"test": "node --test"}},
                indent=2,
            )
            + "\n",
        )
        self._write(
            "tui/package.json",
            json.dumps({"name": "alloy-tui", "version": OLD_VERSION}, indent=2) + "\n",
        )
        self._write(
            "npm-shrinkwrap.json",
            json.dumps(
                {
                    "name": "alloy",
                    "version": OLD_VERSION,
                    "packages": {"": {"name": "alloy", "version": OLD_VERSION}},
                },
                indent=2,
            )
            + "\n",
        )
        for path in ("extensions/ui.ts", "lib/child-runner.mjs", "lib/mcp-client.mjs"):
            self._write(path, f'const version = process.env.ALLOY_VERSION || "{OLD_VERSION}";\n')
        self._write(
            "CHANGELOG.md",
            "# Changelog\n\n## [Unreleased]\n\n### Added\n- Trusted release gate.\n\n"
            "## [1.1.25] - 2026-08-17\n\n### Fixed\n- Previous fix.\n",
        )
        self._write("README.md", "# Alloy\n\nVersion-neutral release documentation.\n")
        self._write("benchmarks/swebench/coordinator.py", "TRUSTED = True\n")
        self._write(
            "benchmarks/swebench/release-transform.json",
            json.dumps(self._policy_value(), indent=2) + "\n",
        )

    def _policy_value(self):
        return {
            "old_version": OLD_VERSION,
            "new_version": NEW_VERSION,
            "release_date": "2026-08-19",
            "json_pointers": {
                "package.json": ["/version"],
                "tui/package.json": ["/version"],
                "npm-shrinkwrap.json": ["/version", "/packages//version"],
            },
            "literals": {
                "extensions/ui.ts": 1,
                "lib/child-runner.mjs": 1,
                "lib/mcp-client.mjs": 1,
            },
            "changelog_path": "CHANGELOG.md",
        }

    def _commit(self, message):
        self._git("add", ".")
        self._git("commit", "-q", "-m", message)
        return self._git("rev-parse", "HEAD").stdout.strip()

    def _write_valid_candidate(self):
        for path in ("package.json", "tui/package.json", "npm-shrinkwrap.json"):
            source = (self.repository / path).read_text()
            (self.repository / path).write_text(source.replace(OLD_VERSION, NEW_VERSION))
        for path in ("extensions/ui.ts", "lib/child-runner.mjs", "lib/mcp-client.mjs"):
            source = (self.repository / path).read_text()
            (self.repository / path).write_text(source.replace(OLD_VERSION, NEW_VERSION))
        changelog = (self.repository / "CHANGELOG.md").read_text()
        changelog = changelog.replace(
            "## [Unreleased]\n\n### Added\n- Trusted release gate.\n",
            "## [Unreleased]\n\n## [1.1.26] - 2026-08-19\n\n"
            "### Added\n- Trusted release gate.\n",
        )
        (self.repository / "CHANGELOG.md").write_text(changelog)

    def _candidate(self, mutate=None):
        self._write_valid_candidate()
        if mutate is not None:
            mutate()
        return self._commit("candidate")

    def _repository_state(self):
        tracked = self._git("ls-files", "-z").stdout.split("\0")
        untracked = self._git("ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0")

        def files(paths):
            return {
                path: ((self.repository / path).stat().st_mode, (self.repository / path).read_bytes())
                for path in paths
                if path
            }

        return {
            "head": self._git("rev-parse", "HEAD").stdout,
            "index": (self.repository / ".git" / "index").read_bytes(),
            "tracked": files(tracked),
            "untracked": files(untracked),
        }

    def assert_rejected(self, mutate, message):
        candidate = self._candidate(mutate)
        with self.assertRaisesRegex(ValueError, message):
            verify_candidate(self.repository, self.authority, candidate, self.policy)

    def test_accepts_only_the_exact_release_transformation(self):
        candidate = self._candidate()

        verified = verify_candidate(self.repository, self.authority, candidate, self.policy)

        self.assertEqual(verified.authority_commit, self.authority)
        self.assertEqual(verified.candidate_commit, candidate)
        self.assertEqual(verified.version, NEW_VERSION)
        self.assertEqual(len(verified.changed_paths), 7)

    def test_rejects_extra_package_scripts_and_dependencies(self):
        def extra_script():
            path = self.repository / "package.json"
            value = json.loads(path.read_text())
            value["scripts"]["postinstall"] = "node steal.js"
            path.write_text(json.dumps(value, indent=2) + "\n")

        self.assert_rejected(extra_script, "package.json")

        self._git("reset", "--hard", "-q", self.authority)

        def dependency():
            path = self.repository / "package.json"
            value = json.loads(path.read_text())
            value["dependencies"] = {"malicious": "1.0.0"}
            path.write_text(json.dumps(value, indent=2) + "\n")

        self.assert_rejected(dependency, "package.json")

    def test_rejects_json_whitespace_edits(self):
        def whitespace():
            path = self.repository / "package.json"
            path.write_text(json.dumps(json.loads(path.read_text()), separators=(",", ":")) + "\n")

        self.assert_rejected(whitespace, "byte-exact")

    def test_rejects_non_release_paths_including_benchmark_code(self):
        self.assert_rejected(
            lambda: self._write("README.md", "changed\n"),
            "unauthorized path",
        )

        self._git("reset", "--hard", "-q", self.authority)
        self.assert_rejected(
            lambda: self._write("benchmarks/swebench/coordinator.py", "TRUSTED = False\n"),
            "unauthorized path",
        )

    def test_rejects_additional_runtime_version_literals(self):
        def additional_literal():
            path = self.repository / "extensions/ui.ts"
            path.write_text(path.read_text() + f'const other = "{NEW_VERSION}";\n')

        self.assert_rejected(additional_literal, "literal count")

    def test_rejects_mode_changes_on_release_paths(self):
        def executable_package():
            (self.repository / "package.json").chmod(0o755)

        self.assert_rejected(executable_package, "mode or object type")

    def test_rejects_rewritten_changelog_text(self):
        def rewritten():
            path = self.repository / "CHANGELOG.md"
            path.write_text(path.read_text().replace("Trusted release gate.", "Untrusted rewrite."))

        self.assert_rejected(rewritten, "changelog")

    def test_rejects_non_ancestor_candidate(self):
        candidate = self._candidate()
        self._git("checkout", "-q", "--orphan", "unrelated")
        self._git("rm", "-q", "-rf", ".")
        self._write("README.md", "unrelated\n")
        unrelated = self._commit("unrelated")

        with self.assertRaisesRegex(ValueError, "ancestor"):
            verify_candidate(self.repository, candidate, unrelated, self.policy)

    def test_coordinator_tree_digest_is_stable_and_content_sensitive(self):
        paths = ("benchmarks/swebench/coordinator.py", "README.md")
        first = coordinator_tree_digest(self.repository, self.authority, paths)
        second = coordinator_tree_digest(self.repository, self.authority, tuple(reversed(paths)))
        candidate = self._candidate(
            lambda: self._write("benchmarks/swebench/coordinator.py", "TRUSTED = False\n")
        )

        self.assertEqual(first, second)
        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertNotEqual(first, coordinator_tree_digest(self.repository, candidate, paths))

    def test_loads_release_policy_from_exact_authority_commit(self):
        policy_path = self.repository / "benchmarks/swebench/release-transform.json"
        policy_path.write_text(json.dumps({**self._policy_value(), "new_version": "9.9.9"}))

        loaded = load_policy_from_commit(self.repository, self.authority)

        self.assertEqual(loaded.old_version, OLD_VERSION)
        self.assertEqual(loaded.new_version, NEW_VERSION)

    def test_host_config_example_uses_non_usable_null_trust_anchors(self):
        example = json.loads(HOST_CONFIG_PATH.read_text())

        self.assertIsNone(example["authority_commit"])
        self.assertIsNone(example["coordinator_tree_sha256"])
        self.assertIsNone(example["gate_public_key_sha256"])
        with self.assertRaisesRegex(ValueError, "not provisioned"):
            load_host_config(HOST_CONFIG_PATH)

    def test_host_config_rejects_zero_trust_anchors(self):
        valid = {
            "authority_commit": "a" * 40,
            "coordinator_tree_sha256": "b" * 64,
            "confinement_policy_sha256": {
                "apparmor": "c" * 64,
                "seccomp": "d" * 64,
            },
            "gate_public_key_sha256": "e" * 64,
        }
        for key, length in (
            ("authority_commit", 40),
            ("coordinator_tree_sha256", 64),
            ("gate_public_key_sha256", 64),
        ):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "host-config.json"
                path.write_text(json.dumps({**valid, key: "0" * length}))
                with self.assertRaisesRegex(ValueError, key):
                    load_host_config(path)

    def test_host_config_accepts_only_provisioned_trust_anchors(self):
        value = {
            "authority_commit": "a" * 40,
            "coordinator_tree_sha256": "b" * 64,
            "confinement_policy_sha256": {
                "apparmor": "c" * 64,
                "seccomp": "d" * 64,
            },
            "gate_public_key_sha256": "e" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "host-config.json"
            path.write_text(json.dumps(value))

            config = load_host_config(path)

        self.assertEqual(config.authority_commit, "a" * 40)
        self.assertEqual(config.coordinator_tree_sha256, "b" * 64)
        self.assertEqual(config.gate_public_key_sha256, "e" * 64)

    def test_cli_verifies_without_checking_out_candidate(self):
        candidate = self._candidate()
        self._git("reset", "--hard", "-q", self.authority)
        policy_path = self.repository / "benchmarks/swebench/release-transform.json"
        policy_path.write_text(json.dumps({**self._policy_value(), "new_version": "9.9.9"}))
        self._write("untracked-state.txt", "must remain untouched\n")
        before = self._repository_state()

        result = main(
            [
                "--repository",
                str(self.repository),
                "--authority",
                self.authority,
                "--candidate",
                candidate,
            ]
        )

        self.assertEqual(result, 0)
        self.assertEqual(self._repository_state(), before)

    def test_cli_rejects_policy_override(self):
        candidate = self._candidate()

        with self.assertRaises(SystemExit):
            main(
                [
                    "--repository",
                    str(self.repository),
                    "--authority",
                    self.authority,
                    "--candidate",
                    candidate,
                    "--policy",
                    str(self.repository / "attacker-policy.json"),
                ]
            )


if __name__ == "__main__":
    unittest.main()
