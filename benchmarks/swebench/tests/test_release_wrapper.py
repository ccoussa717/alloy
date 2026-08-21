import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from benchmarks.swebench.coordinator import COORDINATOR_PATHS
import benchmarks.swebench.host_launcher as host_launcher_module
from benchmarks.swebench.host_launcher import (
    HostPaths,
    _reject_authority_overrides,
    load_trusted_host,
)
from benchmarks.swebench.provision import (
    ProvisionPaths,
    _build_evaluator,
    _ensure_directory,
    _git_command,
    _open_root,
    _publish_new,
    _replace_validated,
    _provision,
)


SHA = "a" * 40
REPO_ROOT = Path(__file__).resolve().parents[3]
WRAPPER = REPO_ROOT / "scripts" / "run-swebench-release-smoke.sh"


class HostLauncherArgumentTests(unittest.TestCase):
    def test_candidate_must_be_exact_canonical_main_tip(self):
        repository = Path("/authority")
        git_home = Path("/git-home")
        candidate = "b" * 40

        for advertised in (
            f"{candidate}\trefs/heads/release\n",
            f"{candidate}\trefs/tags/v1.1.26\n",
        ):
            with self.subTest(advertised=advertised), mock.patch.object(
                host_launcher_module,
                "_run_git",
                return_value=advertised,
            ) as git:
                with self.assertRaisesRegex(ValueError, "canonical main tip"):
                    host_launcher_module._candidate_is_advertised(
                        repository, git_home, candidate
                    )
                git.assert_called_once_with(
                    repository, git_home, "ls-remote", "github", "refs/heads/main"
                )

        main = f"{candidate}\trefs/heads/main\n"
        with mock.patch.object(
            host_launcher_module,
            "_run_git",
            side_effect=[main, "", candidate, ""],
        ) as git:
            host_launcher_module._candidate_is_advertised(
                repository, git_home, candidate
            )
        self.assertEqual(
            git.call_args_list,
            [
                mock.call(
                    repository, git_home, "ls-remote", "github", "refs/heads/main"
                ),
                mock.call(
                    repository,
                    git_home,
                    "fetch",
                    "--no-tags",
                    "github",
                    "refs/heads/main",
                ),
                mock.call(
                    repository,
                    git_home,
                    "rev-parse",
                    "--verify",
                    "FETCH_HEAD^{commit}",
                ),
                mock.call(
                    repository,
                    git_home,
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                ),
            ],
        )

        with mock.patch.object(
            host_launcher_module,
            "_run_git",
            side_effect=[main, "", "c" * 40],
        ):
            with self.assertRaisesRegex(ValueError, "fetched canonical main tip"):
                host_launcher_module._candidate_is_advertised(
                    repository, git_home, candidate
                )

    def test_authorize_retry_rejects_missing_or_blank_reason_before_trust_and_git(self):
        cases = (
            ["authorize-retry", SHA],
            ["authorize-retry", SHA, ""],
            ["authorize-retry", SHA, " "],
            ["authorize-retry", SHA, "\t\n"],
        )
        for arguments in cases:
            with self.subTest(arguments=arguments), mock.patch.object(
                host_launcher_module.os, "geteuid", return_value=0
            ), mock.patch.object(
                host_launcher_module, "_reject_authority_overrides"
            ), mock.patch.object(
                host_launcher_module, "_fixed_environment"
            ), mock.patch.object(
                host_launcher_module, "load_trusted_host"
            ) as trust, mock.patch.object(
                host_launcher_module, "_candidate_is_advertised"
            ) as candidate, mock.patch.object(
                host_launcher_module, "_run_git"
            ) as git, mock.patch.object(
                host_launcher_module, "_authority_main"
            ) as authority:
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    result = host_launcher_module.main(arguments)
                self.assertEqual(result, 64, stderr.getvalue())
                self.assertIn("invalid launcher arguments", stderr.getvalue())
                trust.assert_not_called()
                candidate.assert_not_called()
                git.assert_not_called()
                authority.assert_not_called()


class HostLauncherSubprocessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alloy launcher subprocess ")
        self.root = Path(self.temporary.name)
        self.authority = self.root / "authority"
        package = self.authority / "benchmarks/swebench"
        package.mkdir(parents=True)
        (self.authority / "benchmarks/__init__.py").write_text("")
        (package / "__init__.py").write_text("")
        self.tripwire = self.root / "authority-imported"
        (package / "attempts.py").write_text(
            "from pathlib import Path\n"
            f"Path({str(self.tripwire)!r}).write_text('imported')\n"
            "raise RuntimeError('tripwire authority import')\n"
        )
        source = (REPO_ROOT / "benchmarks/swebench/host_launcher.py").read_text()
        self.launcher = self.root / "alloy-swebench-gate"
        source = source.replace(
            'LAUNCHER_PATH = Path("/usr/local/libexec/alloy-swebench-gate")',
            f"LAUNCHER_PATH = Path({str(self.launcher)!r})",
        ).replace(
            'AUTHORITY_ROOT = STATE_ROOT / "authority"',
            f"AUTHORITY_ROOT = Path({str(self.authority)!r})",
        )
        self.launcher.write_text(source)
        self.launcher.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def test_nonroot_rejection_occurs_before_any_authority_import(self):
        result = subprocess.run(
            ["/usr/bin/python3", "-I", "-E", "-s", str(self.launcher), "dry-run", SHA],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("requires root", result.stderr)
        self.assertFalse(self.tripwire.exists())

    def test_launcher_declares_isolated_python_and_no_early_authority_imports(self):
        source = (REPO_ROOT / "benchmarks/swebench/host_launcher.py").read_text()
        self.assertEqual(
            source.splitlines()[0],
            "#!/usr/bin/env -S /usr/bin/python3 -I -E -s",
        )
        validation_end = source.index("# AUTHORITY_IMPORT_BOUNDARY")
        self.assertNotIn("from benchmarks.", source[:validation_end])
        self.assertNotIn("import benchmarks.", source[:validation_end])

    def test_launcher_git_ignores_global_system_and_environment_contamination(self):
        repository = self.root / "repository"
        repository.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
        subprocess.run(
            ["git", "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "--allow-empty", "-qm", "fixture"],
            cwd=repository,
            check=True,
        )
        malicious_home = self.root / "malicious-home"
        malicious_home.mkdir()
        git_home = self.root / "launcher-git-home"
        git_home.mkdir(mode=0o700)
        sentinels = {
            name: self.root / f"launcher-{name}-executed"
            for name in ("hook", "fsmonitor", "helper", "ext")
        }
        hooks = self.root / "hooks"
        hooks.mkdir()
        for name, sentinel in sentinels.items():
            executable = hooks / name
            executable.write_text(
                f"#!/bin/sh\n/usr/bin/touch {shlex.quote(str(sentinel))}\n"
            )
            executable.chmod(0o755)
        shutil.copyfile(hooks / "hook", hooks / "post-checkout")
        (hooks / "post-checkout").chmod(0o755)
        malicious_config = malicious_home / ".gitconfig"
        malicious_config.write_text(
            "[core]\n"
            f"\thooksPath = {hooks}\n"
            f"\tfsmonitor = {hooks / 'fsmonitor'}\n"
            "[credential]\n"
            f"\thelper = !{hooks / 'helper'}\n"
            f"[url \"ext::{hooks / 'ext'}\"]\n"
            "\tinsteadOf = https://example.invalid/\n"
            "[protocol \"file\"]\n\tallow = always\n"
            "[protocol \"ext\"]\n\tallow = always\n"
        )
        script = f"""
import sys
from pathlib import Path
sys.path.insert(0, {str(REPO_ROOT)!r})
import benchmarks.swebench.host_launcher as launcher
launcher.FIXED_ENV = {{
    **launcher.FIXED_ENV,
    "HOME": {str(malicious_home)!r},
    "GIT_CONFIG_GLOBAL": {str(malicious_config)!r},
    "GIT_CONFIG_SYSTEM": {str(malicious_config)!r},
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "url.ext::environment.insteadOf",
    "GIT_CONFIG_VALUE_0": "https://example.invalid/",
}}
repository = Path({str(repository)!r})
git_home = Path({str(git_home)!r})
assert launcher._run_git(repository, git_home, "config", "--get", "core.hooksPath").strip() == "/dev/null"
assert launcher._run_git(repository, git_home, "config", "--get", "core.fsmonitor").strip() == "false"
assert launcher._run_git(repository, git_home, "config", "--get-all", "credential.helper").strip() == ""
assert launcher._run_git(repository, git_home, "config", "--get", "protocol.file.allow").strip() == "never"
assert launcher._run_git(repository, git_home, "config", "--get", "protocol.ext.allow").strip() == "never"
try:
    launcher._run_git(repository, git_home, "config", "--get-regexp", r"^url\\.")
except ValueError:
    pass
else:
    raise AssertionError("URL rewrite contamination remained visible")
launcher._run_git(repository, git_home, "status", "--porcelain")
launcher._run_git(repository, git_home, "checkout", "--quiet", "HEAD")
for remote in ({('file://' + str(repository))!r}, {('ext::' + str(hooks / 'ext'))!r}):
    try:
        launcher._run_git(repository, git_home, "ls-remote", remote)
    except ValueError:
        pass
    else:
        raise AssertionError(f"unsafe protocol accepted: {{remote}}")
"""
        result = subprocess.run(
            ["/usr/bin/python3", "-I", "-E", "-s", "-c", script],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not path.exists() for path in sentinels.values()))


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
        self.import_tripwire = self.root / "validated-authority-imported"
        (self.source / "benchmarks/__init__.py").write_text(
            "from pathlib import Path\n"
            f"Path({str(self.import_tripwire)!r}).write_text('imported')\n"
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
        self.paths.root.mkdir(mode=0o700)
        self.git_home = self.root / "git-home"
        self.git_home.mkdir(mode=0o700)
        self.apparmor_loads = []
        self.receipt = _provision(
            self.source,
            self.authority,
            self.paths,
            owner_uid=os.geteuid(),
            require_remote_tip=False,
            apparmor_loader=self.apparmor_loads.append,
            git_home=self.git_home,
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
    def _run_installed_launcher(self, source_transform=None, **environment):
        source = (REPO_ROOT / "benchmarks/swebench/host_launcher.py").read_text()
        replacements = {
            'LAUNCHER_PATH = Path("/usr/local/libexec/alloy-swebench-gate")': (
                f"LAUNCHER_PATH = Path({str(self.paths.launcher)!r})"
            ),
            'CONFIG_PATH = Path("/etc/alloy/swebench-gate.json")': (
                f"CONFIG_PATH = Path({str(self.paths.config)!r})"
            ),
            'STATE_ROOT = Path("/var/lib/alloy-swebench-gate")': (
                f"STATE_ROOT = Path({str(self.paths.state)!r})"
            ),
            'FILESYSTEM_ROOT = Path("/")': (
                f"FILESYSTEM_ROOT = Path({str(self.paths.root)!r})"
            ),
            "REQUIRED_UID = 0": f"REQUIRED_UID = {os.geteuid()}",
        }
        for old, new in replacements.items():
            source = source.replace(old, new)
        if source_transform is not None:
            source = source_transform(source)
        launcher = self.root / "subprocess-launcher"
        launcher.write_text(source)
        launcher.chmod(0o755)
        return subprocess.run(
            ["/usr/bin/python3", "-I", "-E", "-s", str(launcher), "dry-run", SHA],
            env={
                **{
                    key: value
                    for key, value in os.environ.items()
                    if not key.startswith("PYTHON")
                },
                **environment,
            },
            text=True,
            capture_output=True,
            check=False,
        )

    def test_root_task11_gate_reaches_authority_import_only_after_validation(self):
        if os.environ.get("ALLOY_SWEBENCH_REQUIRE_DOCKER") != "1":
            self.skipTest("set ALLOY_SWEBENCH_REQUIRE_DOCKER=1 for Task 11 trust transition")
        if os.geteuid() != 0:
            self.fail("ALLOY_SWEBENCH_REQUIRE_DOCKER=1 requires root")

        original = self.config()
        changed = json.loads(json.dumps(original))
        changed["coordinator_tree_sha256"] = "f" * 64
        self.write_config(changed)
        self.import_tripwire.unlink(missing_ok=True)

        def avoid_external_candidate_fetch(source):
            candidate_call = (
                "        _candidate_is_advertised(\n"
                "            host.paths.authority, host.paths.git_home, candidate_commit\n"
                "        )\n"
            )
            self.assertIn(candidate_call, source)
            return source.replace(
                candidate_call,
                "        # Candidate advertisement is outside this local trust-anchor fixture.\n",
            )

        rejected = self._run_installed_launcher(source_transform=avoid_external_candidate_fetch)
        self.assertEqual(rejected.returncode, 2, rejected.stderr)
        self.assertFalse(self.import_tripwire.exists())

        self.write_config(original)
        delegated = self._run_installed_launcher(source_transform=avoid_external_candidate_fetch)
        self.assertEqual(delegated.returncode, 2, delegated.stderr)
        self.assertEqual(self.import_tripwire.read_text(), "imported")

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

    def test_host_validation_rejects_writable_intermediate_parent(self):
        intermediate = self.paths.root / "var/lib"
        intermediate.chmod(0o777)
        try:
            with self.assertRaisesRegex(ValueError, "writable|mode|unsafe"):
                load_trusted_host(self.host_paths, expected_uid=os.geteuid())
        finally:
            intermediate.chmod(0o755)

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

    def test_rejects_nonempty_launcher_git_home_before_running_git(self):
        (self.paths.git_home / ".gitconfig").write_text("[core]\n\tfsmonitor = attacker\n")
        with self.assertRaisesRegex(ValueError, "Git HOME must be empty"):
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

    def test_subprocess_rejects_python_environment_before_drifted_import(self):
        tripwire = self.root / "drift-imported"
        attempts = self.paths.authority / "benchmarks/swebench/attempts.py"
        attempts.write_text(
            f"from pathlib import Path\nPath({str(tripwire)!r}).write_text('imported')\n"
        )
        result = self._run_installed_launcher(
            PYTHONPATH=str(self.root / "attacker"),
            PYTHONSTARTUP=str(self.root / "startup.py"),
            PYTHONHOME=str(self.root / "home"),
            PYTHONINSPECT="1",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Python environment", result.stderr)
        self.assertFalse(tripwire.exists())

    def test_subprocess_rejects_authority_drift_before_import_tripwire(self):
        tripwire = self.root / "drift-imported"
        attempts = self.paths.authority / "benchmarks/swebench/attempts.py"
        attempts.write_text(
            f"from pathlib import Path\nPath({str(tripwire)!r}).write_text('imported')\n"
        )
        # Build the generated launcher after establishing the drift so its own
        # bytes remain outside the authority checkout under test.
        result = self._run_installed_launcher()
        self.assertEqual(result.returncode, 2)
        self.assertIn("clean", result.stderr)
        self.assertFalse(tripwire.exists())

    def test_subprocess_rejects_symlinked_state_before_authority_import(self):
        actual_state = self.root / "actual-state"
        self.paths.state.rename(actual_state)
        self.paths.state.symlink_to(actual_state, target_is_directory=True)
        result = self._run_installed_launcher()
        self.assertEqual(result.returncode, 2)
        self.assertRegex(result.stderr, "unsafe|symlink")
        self.assertFalse(self.import_tripwire.exists())

    def test_subprocess_rejects_wrong_head_before_authority_import(self):
        subprocess.run(
            ["git", "commit", "--allow-empty", "-qm", "wrong head"],
            cwd=self.paths.authority,
            check=True,
        )
        result = self._run_installed_launcher()
        self.assertEqual(result.returncode, 2)
        self.assertIn("authority commit", result.stderr)
        self.assertFalse(self.import_tripwire.exists())

    def test_subprocess_rejects_tree_policy_and_key_drift_before_authority_import(self):
        cases = ("coordinator_tree_sha256", "policy", "gate_public_key_sha256")
        original = self.config()
        for field in cases:
            with self.subTest(field=field):
                changed = json.loads(json.dumps(original))
                if field == "policy":
                    changed["confinement_policy_sha256"]["apparmor"] = "f" * 64
                else:
                    changed[field] = "f" * 64
                self.write_config(changed)
                result = self._run_installed_launcher()
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.import_tripwire.exists())
        self.write_config(original)

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
    def test_provision_git_commands_reuse_only_the_validated_empty_home(self):
        command = _git_command(self.git_home, "status", "--porcelain")
        self.assertEqual(command[:2], ("/usr/bin/env", "-i"))
        for value in (
            f"HOME={self.git_home}",
            "PATH=/usr/bin:/bin",
            "GIT_CONFIG_NOSYSTEM=1",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_SYSTEM=/dev/null",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_ALLOW_PROTOCOL=https",
            "/usr/bin/git",
            "core.hooksPath=/dev/null",
            "core.fsmonitor=false",
            "credential.helper=",
            "protocol.file.allow=never",
            "protocol.ext.allow=never",
        ):
            self.assertIn(value, command)
        self.assertEqual(command[-2:], ("status", "--porcelain"))

    def test_published_files_have_exact_modes_under_restrictive_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            previous_umask = os.umask(0o077)
            try:
                _publish_new(parent_fd, "launcher", b"new\n", 0o755)
                existing = Path(directory) / "config"
                existing.write_bytes(b"old\n")
                existing.chmod(0o600)
                _replace_validated(
                    parent_fd,
                    "config",
                    b"new\n",
                    0o600,
                    os.geteuid(),
                )
            finally:
                os.umask(previous_umask)
                os.close(parent_fd)
            self.assertEqual((Path(directory) / "launcher").stat().st_mode & 0o777, 0o755)
            self.assertEqual((Path(directory) / "config").stat().st_mode & 0o777, 0o600)

    def test_descriptor_walk_rejects_symlink_and_writable_existing_parent(self):
        for unsafe in ("symlink", "writable"):
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                trusted = root / "trusted"
                trusted.mkdir(mode=0o700)
                if unsafe == "symlink":
                    outside = root / "outside"
                    outside.mkdir(mode=0o700)
                    (trusted / "etc").symlink_to(outside, target_is_directory=True)
                else:
                    (trusted / "etc").mkdir(mode=0o777)
                    (trusted / "etc").chmod(0o777)
                root_fd = _open_root(trusted, os.geteuid())
                try:
                    with self.assertRaisesRegex(ValueError, "symlink|writable|mode|unsafe"):
                        _ensure_directory(
                            root_fd,
                            ("etc", "alloy"),
                            0o755,
                            os.geteuid(),
                        )
                finally:
                    os.close(root_fd)

    def test_evaluator_build_uses_fixed_python_binary_wheels_and_exact_lock(self):
        commands = []

        def runner(arguments, **kwargs):
            commands.append((tuple(map(str, arguments)), kwargs))
            if arguments[1:] == ["--version"]:
                return subprocess.CompletedProcess(arguments, 0, "Python 3.14.4\n", "")
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with self.assertRaisesRegex(RuntimeError, "fixture stops after command validation"):
            _build_evaluator(
                self.paths.authority,
                json.loads(
                    (self.paths.authority / "benchmarks/swebench/profile.json").read_text()
                ),
                runner=runner,
                stop_after_install=True,
                pass_fds=(42,),
            )
        arguments = [item[0] for item in commands]
        self.assertIn(("/usr/bin/python3.14", "--version"), arguments)
        pip = next(command for command in arguments if "pip" in command)
        self.assertIn("--require-hashes", pip)
        self.assertIn("--only-binary=:all:", pip)
        self.assertIn("https://pypi.org/simple", pip)
        self.assertTrue(all(item[1]["pass_fds"] == (42,) for item in commands))

    def test_provision_module_contains_no_local_venv_copy_path(self):
        source = (REPO_ROOT / "benchmarks/swebench/provision.py").read_text()
        self.assertNotIn("_copy_prepared_environment", source)
        self.assertNotIn("shutil.copytree", source)

    def test_malicious_local_evaluator_is_ignored_by_authority_install(self):
        local_python = self.source / "benchmarks/swebench/.venv/bin/python"
        self.assertEqual(local_python.read_text(), "prepared evaluator\n")
        installed_venv = self.paths.authority / "benchmarks/swebench/.venv"
        self.assertFalse(installed_venv.exists())
    def test_initial_provision_is_audited_private_and_loads_exact_apparmor_policy(self):
        self.assertEqual(self.receipt["schema_version"], 1)
        self.assertEqual(self.receipt["action"], "provision")
        self.assertEqual(self.receipt["authority_commit"], self.authority)
        self.assertEqual(self.paths.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.paths.private_key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths.public_key.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.paths.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths.launcher.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.paths.git_home.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.paths.git_home.iterdir()), [])
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
                git_home=self.git_home,
            )

    def test_failed_initial_apparmor_load_leaves_no_false_provisioning_anchor(self):
        retry_paths = ProvisionPaths.under(self.root / "retry system")
        retry_paths.root.mkdir(mode=0o700)

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
                git_home=self.git_home,
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
            git_home=self.git_home,
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
                git_home=self.git_home,
            )

        receipt = _provision(
            self.source,
            replacement,
            self.paths,
            replace_authority=(self.authority, replacement),
            owner_uid=os.geteuid(),
            require_remote_tip=False,
            apparmor_loader=lambda _path: None,
            git_home=self.git_home,
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
                git_home=self.git_home,
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
                git_home=self.git_home,
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
                git_home=self.git_home,
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

    def _provision_ceremony(self):
        result = self._run("provision", SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def _git_function(self, ceremony):
        start = ceremony.index("git() {")
        end = ceremony.index("\n}", start) + 2
        return ceremony[start:end]

    def _ceremony_body(self, ceremony):
        start = ceremony.index("\n") + 1
        end = ceremony.rindex("\nALLOY_SWEBENCH_BOOTSTRAP")
        return ceremony[start:end]

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

    def test_provision_prints_fixed_explicit_sha_ceremony_without_executing_local_code(self):
        sentinels = []
        for relative in (
            "benchmarks/swebench/provision.py",
            "sitecustomize.py",
            "benchmarks/__init__.py",
            "benchmarks/swebench/.venv/bin/python",
        ):
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            sentinel = self.root / (relative.replace("/", "-") + "-executed")
            sentinels.append(sentinel)
            path.write_text(
                "from pathlib import Path\n"
                f"Path({str(sentinel)!r}).write_text('executed')\n"
            )
            path.chmod(0o755)
        result = self._run("provision", SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.commands.exists())
        self.assertTrue(all(not sentinel.exists() for sentinel in sentinels))
        self.assertIn("https://github.com/ccoussa717/alloy.git", result.stdout)
        self.assertIn(SHA, result.stdout)
        self.assertIn("/usr/bin/git", result.stdout)
        self.assertIn("/usr/bin/python3 -I -E -s", result.stdout)
        self.assertNotIn(str(self.repo), result.stdout)
        self.assertNotIn("$'", result.stdout)
        self.assertIn("/usr/bin/printf '%s\\t%s'", result.stdout)

    def test_provision_uses_validated_ephemeral_run_bootstrap_with_cleanup(self):
        ceremony = self._provision_ceremony()
        self.assertNotIn("/var/lib/alloy-swebench-bootstrap", ceremony)
        self.assertIn("/usr/bin/test ! -L /run", ceremony)
        self.assertIn("/usr/bin/stat -c", ceremony)
        self.assertIn("directory:0:0:", ceremony)
        self.assertIn("/usr/bin/mktemp -d /run/alloy-swebench-bootstrap.XXXXXXXX", ceremony)
        self.assertIn("directory:0:0:700", ceremony)
        self.assertIn("trap cleanup 0", ceremony)
        self.assertIn('/usr/bin/rm -rf -- "$bootstrap"', ceremony)
        self.assertNotIn("exec /usr/bin/python3", ceremony)

    def test_bootstrap_cleanup_executes_after_success_and_failure(self):
        ceremony = self._provision_ceremony()
        body = self._ceremony_body(ceremony)
        prefix = body.split('home="$bootstrap/home"', 1)[0]
        for exit_code in (0, 23):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory(
                prefix="alloy-run-"
            ) as directory:
                parent = Path(directory)
                parent.chmod(0o700)
                executable = prefix.replace("/run", str(parent)).replace(
                    "directory:0:0:",
                    f"directory:{os.geteuid()}:{os.getegid()}:",
                )
                executable += f"\nexit {exit_code}\n"
                result = subprocess.run(
                    ["/bin/sh", "-eu", "-s", "--", SHA],
                    input=executable,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertEqual(list(parent.glob("alloy-swebench-bootstrap.*")), [])

    def test_every_bootstrap_git_command_has_an_empty_fixed_environment_and_safe_config(self):
        ceremony = self._provision_ceremony()
        git_function = self._git_function(ceremony)
        for value in (
            "/usr/bin/env -i",
            'HOME="$home"',
            "PATH=/usr/bin:/bin",
            "GIT_CONFIG_NOSYSTEM=1",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_SYSTEM=/dev/null",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_ALLOW_PROTOCOL=https",
            "/usr/bin/git",
            "-c core.hooksPath=/dev/null",
            "-c core.fsmonitor=false",
            "-c credential.helper=",
            "-c protocol.file.allow=never",
            "-c protocol.ext.allow=never",
        ):
            self.assertIn(value, git_function)
        self.assertNotIn("/usr/bin/git", ceremony.replace(git_function, ""))
        self.assertIn(
            'test "$(git -C "$checkout" remote get-url --all github)" = "$canonical"',
            ceremony,
        )
        self.assertIn(
            'test "$(git -C "$checkout" rev-parse --verify FETCH_HEAD^{commit})" = "$authority"',
            ceremony,
        )
        self.assertIn('case "$tree" in *"160000 commit "*', ceremony)
        self.assertIn('test ! -e "$checkout/.gitmodules"', ceremony)

    def test_bootstrap_git_ignores_config_injection_hooks_fsmonitor_helpers_and_protocols(self):
        ceremony = self._provision_ceremony()
        git_function = self._git_function(ceremony)
        with tempfile.TemporaryDirectory(prefix="alloy git contamination ") as directory:
            root = Path(directory)
            malicious_home = root / "malicious-home"
            empty_home = root / "empty-home"
            repository = root / "repository"
            sentinels = {
                name: root / f"{name}-executed"
                for name in ("hook", "fsmonitor", "helper", "ext")
            }
            malicious_home.mkdir()
            empty_home.mkdir(mode=0o700)
            for name, sentinel in sentinels.items():
                executable = root / name
                executable.write_text(f"#!/bin/sh\n/usr/bin/touch {shlex.quote(str(sentinel))}\n")
                executable.chmod(0o755)
            hooks = root / "hooks"
            hooks.mkdir()
            shutil.copyfile(root / "hook", hooks / "pre-commit")
            (hooks / "pre-commit").chmod(0o755)
            global_config = malicious_home / ".gitconfig"
            global_config.write_text(
                "[core]\n"
                f"\thooksPath = {hooks}\n"
                f"\tfsmonitor = {root / 'fsmonitor'}\n"
                "[credential]\n"
                f"\thelper = !{root / 'helper'}\n"
                f"[url \"ext::{root / 'ext'}\"]\n"
                "\tinsteadOf = https://example.invalid/\n"
                "[protocol \"file\"]\n\tallow = always\n"
                "[protocol \"ext\"]\n\tallow = always\n"
            )
            probe = (
                "set -eu\n"
                f"home={shlex.quote(str(empty_home))}\n"
                f"{git_function}\n"
                f"git init --quiet {shlex.quote(str(repository))}\n"
                f"git -C {shlex.quote(str(repository))} -c user.name=Tests "
                "-c user.email=tests@example.com commit --allow-empty --quiet -m fixture\n"
                f"git -C {shlex.quote(str(repository))} status --porcelain\n"
                f"test \"$(git -C {shlex.quote(str(repository))} config --get core.hooksPath)\" = /dev/null\n"
                f"test \"$(git -C {shlex.quote(str(repository))} config --get core.fsmonitor)\" = false\n"
                f"test -z \"$(git -C {shlex.quote(str(repository))} config --get-all credential.helper)\"\n"
                f"test \"$(git -C {shlex.quote(str(repository))} config --get protocol.file.allow)\" = never\n"
                f"test \"$(git -C {shlex.quote(str(repository))} config --get protocol.ext.allow)\" = never\n"
                f"test -z \"$(git -C {shlex.quote(str(repository))} config --get-regexp '^url\\.' || :)\"\n"
                f"if git ls-remote file://{shlex.quote(str(repository))}; then exit 91; fi\n"
                f"if git ls-remote 'ext::{root / 'ext'}'; then exit 92; fi\n"
            )
            environment = {
                **os.environ,
                "HOME": str(malicious_home),
                "GIT_CONFIG_GLOBAL": str(global_config),
                "GIT_CONFIG_SYSTEM": str(global_config),
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "url.ext::malicious.insteadOf",
                "GIT_CONFIG_VALUE_0": "https://example.invalid/",
            }
            result = subprocess.run(
                ["/bin/sh", "-eu"],
                input=probe,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(all(not path.exists() for path in sentinels.values()))

    def test_provision_requires_one_explicit_full_lowercase_authority_sha(self):
        for arguments in (("provision",), ("provision", "A" * 40), ("provision", SHA, SHA)):
            with self.subTest(arguments=arguments):
                result = self._run(*arguments)
                self.assertEqual(result.returncode, 64)
                self.assertIn("usage:", result.stderr)
                self.assertFalse(self.commands.exists())

    def test_unknown_or_missing_commands_fail_before_any_tool_execution(self):
        for arguments in ((), ("unknown",)):
            with self.subTest(arguments=arguments):
                result = self._run(*arguments)
                self.assertEqual(result.returncode, 64)
                self.assertFalse(self.commands.exists())


if __name__ == "__main__":
    unittest.main()
