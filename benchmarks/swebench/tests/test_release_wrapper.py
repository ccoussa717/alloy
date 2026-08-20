import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from benchmarks.swebench.coordinator import COORDINATOR_PATHS
from benchmarks.swebench.host_launcher import (
    HostPaths,
    _reject_authority_overrides,
    load_trusted_host,
)
from benchmarks.swebench.provision import ProvisionPaths, _provision


SHA = "a" * 40
REPO_ROOT = Path(__file__).resolve().parents[3]
WRAPPER = REPO_ROOT / "scripts" / "run-swebench-release-smoke.sh"


class TrustedHostFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy host gate ")
        self.root = Path(self.temporary.name)
        self.source = self.root / "reviewed source"
        self.source.mkdir()
        for relative in (*COORDINATOR_PATHS, "benchmarks/swebench/host_launcher.py"):
            source = REPO_ROOT / relative
            destination = self.source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        (self.source / ".gitignore").write_text(
            "benchmarks/swebench/.venv/\nbenchmarks/swebench/.cache/\n"
        )
        self._git("init", "-q")
        self._git("config", "user.email", "tests@example.com")
        self._git("config", "user.name", "Tests")
        self._git("remote", "add", "github", "https://github.com/ccoussa717/alloy.git")
        self._git("add", ".")
        self._git("commit", "-qm", "authority")
        self.authority = self._git("rev-parse", "HEAD", output=True)
        evaluator = self.source / "benchmarks/swebench/.venv/bin"
        evaluator.mkdir(parents=True)
        (evaluator / "python").write_text("prepared evaluator\n")
        target = self.source / "benchmarks/swebench/.cache/target.git/.git"
        target.mkdir(parents=True)
        (target / "HEAD").write_text("prepared target\n")
        self.paths = ProvisionPaths.under(self.root / "system root")
        self.apparmor_loads = []
        self.receipt = _provision(
            self.source,
            self.authority,
            self.paths,
            owner_uid=os.geteuid(),
            require_remote_tip=False,
            apparmor_loader=self.apparmor_loads.append,
        )
        self.host_paths = HostPaths.from_provision(self.paths)

    def tearDown(self):
        self.temporary.cleanup()

    def _git(self, *arguments, output=False):
        result = subprocess.run(
            ["git", *arguments],
            cwd=self.source,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() if output else None

    def config(self):
        return json.loads(self.paths.config.read_text())

    def write_config(self, value):
        self.paths.config.write_text(json.dumps(value, sort_keys=True) + "\n")
        self.paths.config.chmod(0o600)


class HostLauncherTests(TrustedHostFixture):
    def test_provisioned_host_uses_exact_fixed_tree_policy_and_public_key_digests(self):
        trusted = load_trusted_host(self.host_paths, expected_uid=os.geteuid())

        self.assertEqual(trusted.config.authority_commit, self.authority)
        self.assertEqual(
            trusted.config.coordinator_tree_sha256,
            self.receipt["coordinator_tree_sha256"],
        )
        self.assertEqual(
            dict(trusted.config.confinement_policy_sha256),
            self.receipt["confinement_policy_sha256"],
        )
        self.assertEqual(
            hashlib.sha256(self.paths.public_key.read_bytes()).hexdigest(),
            trusted.config.gate_public_key_sha256,
        )

    def test_rejects_non_owned_or_group_writable_config(self):
        self.paths.config.chmod(0o620)
        with self.assertRaisesRegex(ValueError, "config.*mode"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

        self.paths.config.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "owned"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid() + 1)

    def test_rejects_non_private_protected_state(self):
        self.paths.state.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "state.*0700"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

    def test_rejects_dirty_or_wrong_authority_checkout(self):
        authority_file = self.paths.authority / "benchmarks/swebench/coordinator.py"
        authority_file.write_text(authority_file.read_text() + "# dirty\n")
        with self.assertRaisesRegex(ValueError, "clean"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

        subprocess.run(
            ["git", "checkout", "--", "benchmarks/swebench/coordinator.py"],
            cwd=self.paths.authority,
            check=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-qm", "wrong checkout"],
            cwd=self.paths.authority,
            check=True,
        )
        with self.assertRaisesRegex(ValueError, "authority commit"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

    def test_rejects_tree_policy_and_public_key_digest_drift(self):
        cases = (
            ("coordinator_tree_sha256", "coordinator tree"),
            ("policy", "confinement policy"),
            ("gate_public_key_sha256", "public key"),
        )
        original = self.config()
        for field, message in cases:
            with self.subTest(field=field):
                changed = json.loads(json.dumps(original))
                if field == "policy":
                    changed["confinement_policy_sha256"]["apparmor"] = "f" * 64
                else:
                    changed[field] = "f" * 64
                self.write_config(changed)
                with self.assertRaisesRegex(ValueError, message):
                    load_trusted_host(self.host_paths, expected_uid=os.geteuid())
        self.write_config(original)

    def test_rejects_wrong_public_key_bytes(self):
        self.paths.public_key.write_text("not the provisioned public key\n")
        self.paths.public_key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "public key"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

    def test_rejects_installed_launcher_not_matching_authority_blob(self):
        self.paths.launcher.write_text("#!/usr/bin/python3\nraise SystemExit(0)\n")
        self.paths.launcher.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "launcher"):
            load_trusted_host(self.host_paths, expected_uid=os.geteuid())

    def test_alternate_config_and_authority_environment_variables_are_forbidden(self):
        for name in ("ALLOY_SWEBENCH_CONFIG", "ALLOY_SWEBENCH_AUTHORITY"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "override"):
                _reject_authority_overrides({name: str(self.root / "attacker")})

    def test_direct_candidate_runner_invocation_remains_blocked(self):
        result = subprocess.run(
            [
                "python3",
                str(REPO_ROOT / "benchmarks/swebench/runner.py"),
                "dry-run",
                SHA,
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("direct runner execution is forbidden", result.stderr)

        coordinator = subprocess.run(
            ["python3", "-m", "benchmarks.swebench.coordinator"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(coordinator.returncode, 0)
        self.assertIn("direct coordinator execution is forbidden", coordinator.stderr)


class ProvisionTests(TrustedHostFixture):
    def test_initial_provision_is_audited_private_and_loads_exact_apparmor_policy(self):
        self.assertEqual(self.receipt["schema_version"], 1)
        self.assertEqual(self.receipt["action"], "provision")
        self.assertEqual(self.receipt["authority_commit"], self.authority)
        self.assertEqual(self.paths.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.paths.private_key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths.public_key.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.paths.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths.launcher.stat().st_mode & 0o777, 0o755)
        self.assertEqual(
            self.apparmor_loads,
            [
                self.paths.authority
                / "benchmarks/swebench/policies/alloy-swebench-gate.apparmor"
            ],
        )

    def test_one_time_provision_refuses_implicit_replacement(self):
        with self.assertRaisesRegex(FileExistsError, "already provisioned"):
            _provision(
                self.source,
                self.authority,
                self.paths,
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=lambda _path: None,
            )

    def test_failed_initial_apparmor_load_leaves_no_false_provisioning_anchor(self):
        retry_paths = ProvisionPaths.under(self.root / "retry system")

        def fail_load(_path):
            raise RuntimeError("AppArmor load failed")

        with self.assertRaisesRegex(RuntimeError, "AppArmor load failed"):
            _provision(
                self.source,
                self.authority,
                retry_paths,
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=fail_load,
            )
        self.assertFalse(retry_paths.config.exists())
        self.assertFalse(retry_paths.authority.exists())
        self.assertFalse(retry_paths.private_key.exists())
        self.assertFalse(retry_paths.public_key.exists())

        receipt = _provision(
            self.source,
            self.authority,
            retry_paths,
            owner_uid=os.geteuid(),
            require_remote_tip=False,
            apparmor_loader=lambda _path: None,
        )
        self.assertEqual(receipt["authority_commit"], self.authority)

    def test_replacement_requires_exact_old_authority_and_preserves_gate_key(self):
        source_file = self.source / "benchmarks/swebench/coordinator.py"
        source_file.write_text(source_file.read_text() + "\n# reviewed replacement\n")
        self._git("add", str(source_file.relative_to(self.source)))
        self._git("commit", "-qm", "replacement")
        replacement = self._git("rev-parse", "HEAD", output=True)
        key_digest = hashlib.sha256(self.paths.private_key.read_bytes()).hexdigest()

        with self.assertRaisesRegex(ValueError, "old authority"):
            _provision(
                self.source,
                replacement,
                self.paths,
                replace_authority=("f" * 40, replacement),
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=lambda _path: None,
            )

        receipt = _provision(
            self.source,
            replacement,
            self.paths,
            replace_authority=(self.authority, replacement),
            owner_uid=os.geteuid(),
            require_remote_tip=False,
            apparmor_loader=lambda _path: None,
        )
        self.assertEqual(receipt["action"], "replace-authority")
        self.assertEqual(receipt["previous_authority_commit"], self.authority)
        self.assertEqual(self.config()["authority_commit"], replacement)
        self.assertEqual(
            hashlib.sha256(self.paths.private_key.read_bytes()).hexdigest(), key_digest
        )
        load_trusted_host(self.host_paths, expected_uid=os.geteuid())

    def test_provision_rejects_dirty_wrong_or_noncanonical_source_checkout(self):
        other_paths = ProvisionPaths.under(self.root / "other system")
        (self.source / "dirty").write_text("untracked\n")
        with self.assertRaisesRegex(ValueError, "clean"):
            _provision(
                self.source,
                self.authority,
                other_paths,
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=lambda _path: None,
            )
        (self.source / "dirty").unlink()

        with self.assertRaisesRegex(ValueError, "checked-out authority"):
            _provision(
                self.source,
                "f" * 40,
                other_paths,
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=lambda _path: None,
            )

        self._git("remote", "set-url", "github", "https://example.com/attacker.git")
        with self.assertRaisesRegex(ValueError, "canonical"):
            _provision(
                self.source,
                self.authority,
                other_paths,
                owner_uid=os.geteuid(),
                require_remote_tip=False,
                apparmor_loader=lambda _path: None,
            )

    def test_temp_root_provisioning_never_names_live_system_paths(self):
        serialized = json.dumps(self.receipt, sort_keys=True)
        self.assertNotIn('"/etc/', serialized)
        self.assertNotIn('"/usr/local/', serialized)
        self.assertNotIn('"/var/lib/', serialized)
        for path in self.paths.all_paths():
            self.assertTrue(path.is_relative_to(self.root / "system root"))


class ReleaseWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy wrapper ")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "candidate repo"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.bin.mkdir()
        (self.repo / "benchmarks/swebench/tests").mkdir(parents=True)
        (self.repo / "benchmarks/swebench/requirements.lock").write_text("lock\n")
        (self.repo / "benchmarks/swebench/runner.py").write_text("CANDIDATE_RUNNER\n")
        (self.repo / "benchmarks/swebench/profile.json").write_text("CANDIDATE_PROFILE\n")
        self.commands = self.root / "commands"
        self._executable(
            self.bin / "git",
            "#!/bin/sh\n"
            "if [ \"$1\" = \"clone\" ]; then\n"
            "  for destination do :; done\n"
            "  mkdir -p \"$destination/.git\"\n"
            "  exit 0\n"
            "fi\n"
            "if [ \"$1\" = \"-C\" ]; then\n"
            "  [ \"$3 $4\" = \"rev-parse HEAD\" ] && printf '%s\\n' d16bfe05a744909de4b27f5875fe0d4ed41ce607\n"
            "  exit 0\n"
            "fi\n"
            "[ \"$1 $2\" = \"rev-parse --show-toplevel\" ] && "
            "printf '%s\\n' \"$FAKE_REPO\" && exit 0\n"
            "[ \"$1 $2\" = \"rev-parse HEAD\" ] && printf '%s\\n' \"$FAKE_SHA\" && exit 0\n"
            "exit 90\n",
        )
        self._executable(
            self.bin / "sudo",
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_COMMAND_LOG\"\nexit 77\n",
        )
        self._executable(
            self.bin / "python3",
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$FAKE_COMMAND_LOG\"\n"
            "if [ \"$1 $2\" = \"-m venv\" ]; then\n"
            "  shift 2\n"
            "  [ \"${1:-}\" = \"--copies\" ] && shift\n"
            "  mkdir -p \"$1/bin\"\n"
            "  cp \"$0\" \"$1/bin/python\"\n"
            "fi\n"
            "exit 0\n",
        )
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_REPO": str(self.repo),
            "FAKE_SHA": SHA,
            "FAKE_COMMAND_LOG": str(self.commands),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def _executable(self, path, content):
        path.write_text(content)
        path.chmod(0o755)

    def _run(self, *arguments):
        return subprocess.run(
            ["/bin/bash", str(WRAPPER), *arguments],
            cwd=self.repo,
            env=self.environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_test_mode_is_model_free_and_setup_is_non_authority(self):
        result = self._run("test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-m unittest discover", self.commands.read_text())

        self.commands.unlink()
        result = self._run("setup")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands.read_text()
        self.assertIn("-m venv", commands)
        self.assertIn("--require-hashes", commands)
        self.assertNotIn("provision", commands)

    def test_official_modes_have_exact_arity_and_lowercase_candidate_sha(self):
        for arguments in (
            ("dry-run",),
            ("release", "A" * 40),
            ("release", SHA, "extra"),
            ("authorize-retry", SHA),
            ("authorize-retry", SHA, "reason", "extra"),
        ):
            with self.subTest(arguments=arguments):
                result = self._run(*arguments)
                self.assertEqual(result.returncode, 64)
                self.assertIn("usage:", result.stderr)

    def test_wrapper_inverts_trust_and_never_archives_or_executes_candidate_benchmark_code(self):
        source = WRAPPER.read_text()
        self.assertNotIn("git archive", source)
        self.assertNotIn("tar -", source)
        self.assertNotIn("runner.py", source)
        self.assertNotIn("profile.json", source)
        self.assertNotIn("ALLOY_BENCH_REMOTE", source)
        self.assertIn("/usr/bin/sudo -n /usr/local/libexec/alloy-swebench-gate", source)

        result = self._run("dry-run", SHA)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.commands.exists())
        self.assertEqual(
            (self.repo / "benchmarks/swebench/runner.py").read_text(),
            "CANDIDATE_RUNNER\n",
        )
        self.assertEqual(
            (self.repo / "benchmarks/swebench/profile.json").read_text(),
            "CANDIDATE_PROFILE\n",
        )

    def test_provision_is_separate_and_official_modes_pass_only_reviewed_arguments(self):
        source = WRAPPER.read_text()
        self.assertRegex(source, r'exec /usr/bin/sudo -n /usr/local/libexec/alloy-swebench-gate "\$SUBCOMMAND" "\$CANDIDATE_SHA"')
        self.assertRegex(source, r'authorize-retry.*RETRY_REASON')
        self.assertNotRegex(source, r'ALLOY_SWEBENCH_(?:CONFIG|AUTHORITY)')

    def test_unknown_or_missing_commands_fail_before_any_tool_execution(self):
        for arguments in ((), ("unknown",)):
            with self.subTest(arguments=arguments):
                result = self._run(*arguments)
                self.assertEqual(result.returncode, 64)
                self.assertFalse(self.commands.exists())


if __name__ == "__main__":
    unittest.main()
