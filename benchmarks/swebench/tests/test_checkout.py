import dataclasses
import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swebench import checkout as checkout_module
from benchmarks.swebench.checkout import (
    ExportBounds,
    capture_patch,
    reconstruct_trusted_checkout,
    validate_exported_tar,
)


def git(repository: Path, *arguments: str, input: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository,
        input=input,
        capture_output=True,
        check=True,
    ).stdout


def initialize_repository(path: Path) -> None:
    path.mkdir()
    git(path, "init", "-q")
    git(path, "config", "user.email", "bench@example.invalid")
    git(path, "config", "user.name", "Benchmark")
    (path / ".gitignore").write_text("ignored.bin\n")
    (path / "changed.txt").write_text("base\n")
    (path / "deleted.txt").write_text("delete me\n")
    (path / "mixed.txt").write_text("base\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "base")


def archive_worktree(source: Path, destination: Path) -> None:
    def normalize_owner(member: tarfile.TarInfo) -> tarfile.TarInfo:
        member.uid = member.gid = 65532
        member.uname = member.gname = ""
        return member

    with tarfile.open(destination, "w") as archive:
        for path in sorted(source.rglob("*")):
            if ".git" in path.relative_to(source).parts:
                continue
            archive.add(
                path,
                arcname=path.relative_to(source),
                recursive=False,
                filter=normalize_owner,
            )


def write_sparse_tar(path: Path, members: list[tuple[str, int]]) -> None:
    with path.open("wb") as output:
        for name, size in members:
            member = tarfile.TarInfo(name)
            member.uid = member.gid = 65532
            member.size = size
            output.write(member.tobuf())
            output.seek((size + tarfile.BLOCKSIZE - 1) // tarfile.BLOCKSIZE * tarfile.BLOCKSIZE, 1)
        output.write(b"\0" * tarfile.RECORDSIZE)


def staging_root(exported) -> Path:
    return Path(os.readlink(f"/proc/self/fd/{exported._owner.root_fd}"))


class ExportValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.archive = self.root / "export.tar"
        self.bounds = ExportBounds(max_files=20_000, max_file_bytes=16 * 1024**2, max_total_bytes=256 * 1024**2)

    def tearDown(self):
        self.directory.cleanup()

    def write_members(self, members: list[tuple[tarfile.TarInfo, bytes]]) -> None:
        with tarfile.open(self.archive, "w") as archive:
            for member, content in members:
                member.uid = 65532
                member.gid = 65532
                archive.addfile(member, io.BytesIO(content) if member.isreg() else None)

    @staticmethod
    def file(name: str, content: bytes = b"data", mode: int = 0o644) -> tuple[tarfile.TarInfo, bytes]:
        member = tarfile.TarInfo(name)
        member.size = len(content)
        member.mode = mode
        return member, content

    def assert_rejected(self, members, message: str) -> None:
        self.write_members(members)
        with self.assertRaisesRegex(ValueError, message):
            validate_exported_tar(self.archive, self.bounds)

    def test_accepts_regular_directories_and_safe_symlinks_with_normalized_modes(self):
        directory = tarfile.TarInfo("bin")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o777
        link = tarfile.TarInfo("current")
        link.type = tarfile.SYMTYPE
        link.linkname = "bin/tool"
        self.write_members([directory_and_data(directory), self.file("bin/tool", b"tool\n", 0o751), (link, b"")])

        exported = validate_exported_tar(self.archive, self.bounds)

        self.assertEqual(exported.file_count, 3)
        self.assertEqual(exported.total_bytes, 5)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            exported.total_bytes = 0
        root = staging_root(exported)
        self.assertEqual((root / "bin" / "tool").stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(root / "current"), "bin/tool")
        exported.close()

    def test_rejects_non_normalized_absolute_parent_and_git_paths(self):
        for name in ("./file", "dir//file", "/absolute", "../escape", "dir/../escape", ".git/config", "nested/.git/config"):
            with self.subTest(name=name):
                self.assert_rejected([self.file(name)], "path|Git metadata")

    def test_rejects_duplicate_normalized_names_and_parent_type_conflicts(self):
        self.assert_rejected([self.file("same"), self.file("same")], "duplicate")
        self.assert_rejected([self.file("parent/child"), self.file("parent")], "conflict")
        link = tarfile.TarInfo("link")
        link.type = tarfile.SYMTYPE
        link.linkname = "target"
        self.assert_rejected([(link, b""), self.file("link/child")], "conflict")

    def test_rejects_hardlinks_fifos_devices_and_unknown_types(self):
        cases = (
            (tarfile.LNKTYPE, "hard"),
            (tarfile.FIFOTYPE, "fifo"),
            (tarfile.CHRTYPE, "character"),
            (tarfile.BLKTYPE, "block"),
            (b"X", "unsupported"),
        )
        for kind, label in cases:
            with self.subTest(label=label):
                member = tarfile.TarInfo(label)
                member.type = kind
                if kind == tarfile.LNKTYPE:
                    member.linkname = "target"
                self.assert_rejected([(member, b"")], "type|hard link|malformed")

    def test_rejects_setid_and_sticky_modes(self):
        for mode in (0o4644, 0o2644, 0o1644):
            with self.subTest(mode=oct(mode)):
                self.assert_rejected([self.file("unsafe", mode=mode)], "mode")

    def test_rejects_escaping_absolute_and_git_target_symlinks(self):
        for target in ("../../outside", "/outside", ".git/config", "nested/../.git/config"):
            with self.subTest(target=target):
                link = tarfile.TarInfo("dir/link")
                link.type = tarfile.SYMTYPE
                link.linkname = target
                self.assert_rejected([(link, b"")], "symlink")

    def test_rejects_symlink_chains_that_escape_or_cycle(self):
        up = tarfile.TarInfo("d/up")
        up.type = tarfile.SYMTYPE
        up.linkname = ".."
        escape = tarfile.TarInfo("escape")
        escape.type = tarfile.SYMTYPE
        escape.linkname = "d/up/../outside"
        self.assert_rejected([(up, b""), (escape, b"")], "symlink")

        first = tarfile.TarInfo("first")
        first.type = tarfile.SYMTYPE
        first.linkname = "second"
        second = tarfile.TarInfo("second")
        second.type = tarfile.SYMTYPE
        second.linkname = "first"
        self.assert_rejected([(first, b""), (second, b"")], "cycle")

    def test_rejects_compressed_archives_and_unbounded_paths(self):
        with tarfile.open(self.archive, "w:gz") as archive:
            member, content = self.file("compressed")
            member.uid = member.gid = 65532
            archive.addfile(member, io.BytesIO(content))
        with self.assertRaisesRegex(ValueError, "malformed|uncompressed"):
            validate_exported_tar(self.archive, self.bounds)

        for name in ("a" * 4097, "/".join(["d"] * 129)):
            with self.subTest(length=len(name)):
                self.assert_rejected([self.file(name, b"")], "length|depth")

    def test_enforces_count_per_file_and_total_bounds(self):
        tiny = ExportBounds(max_files=2, max_file_bytes=4, max_total_bytes=5)
        cases = (
            ([self.file("a", b""), self.file("b", b""), self.file("c", b"")], "file count"),
            ([self.file("large", b"12345")], "per-file"),
            ([self.file("a", b"123"), self.file("b", b"456")], "total")
        )
        for members, message in cases:
            with self.subTest(message=message):
                self.write_members(members)
                with self.assertRaisesRegex(ValueError, message):
                    validate_exported_tar(self.archive, tiny)

    def test_enforces_the_exact_production_boundaries(self):
        self.assertEqual(
            ExportBounds(),
            ExportBounds(20_000, 16 * 1024**2, 256 * 1024**2),
        )
        oversized = tarfile.TarInfo("oversized")
        oversized.size = 16 * 1024**2 + 1
        oversized.uid = oversized.gid = 65532
        self.archive.write_bytes(oversized.tobuf())
        with self.assertRaisesRegex(ValueError, "per-file"):
            validate_exported_tar(self.archive, self.bounds)

        with tarfile.open(self.archive, "w") as archive:
            for index in range(20_001):
                member = tarfile.TarInfo(f"file-{index:05d}")
                member.uid = member.gid = 65532
                archive.addfile(member, io.BytesIO())
        with self.assertRaisesRegex(ValueError, "file count"):
            validate_exported_tar(self.archive, self.bounds)

    def test_rejects_exact_256_mib_plus_one_total_from_sparse_tar(self):
        write_sparse_tar(
            self.archive,
            [(f"part-{index:02d}", 16 * 1024**2) for index in range(16)]
            + [("overflow", 1)],
        )
        self.assertLess(self.archive.stat().st_blocks * 512, 1024 * 1024)
        with mock.patch.object(
            checkout_module,
            "_write_regular",
            side_effect=AssertionError("payload extraction must not start"),
        ):
            with self.assertRaisesRegex(ValueError, "total"):
                validate_exported_tar(self.archive, self.bounds)

    def test_rejects_untrusted_ownership_and_archive_symlinks(self):
        member, content = self.file("owned")
        member.uid = member.gid = 1234
        with tarfile.open(self.archive, "w") as archive:
            archive.addfile(member, io.BytesIO(content))
        with self.assertRaisesRegex(ValueError, "ownership"):
            validate_exported_tar(self.archive, self.bounds)

        target = self.root / "target.tar"
        self.write_members([self.file("safe")])
        self.archive.replace(target)
        self.archive.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "malformed|unsafe"):
            validate_exported_tar(self.archive, self.bounds)

    def test_rejects_invalid_bounds(self):
        for values in ((0, 1, 1), (1, 0, 1), (1, 2, 1), (1, 1, 0)):
            with self.subTest(values=values), self.assertRaises(ValueError):
                ExportBounds(*values)


def directory_and_data(member: tarfile.TarInfo) -> tuple[tarfile.TarInfo, bytes]:
    return member, b""


class TrustedCheckoutTests(unittest.TestCase):
    def test_capture_rejects_an_agent_owned_repository_before_reading_git_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            git(repository, "init", "-q")
            with self.assertRaisesRegex(ValueError, "freshly reconstructed"):
                capture_patch(repository)

    def test_capture_trust_is_single_use(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            initialize_repository(base)
            export = root / "export.tar"
            archive_worktree(base, export)
            exported = validate_exported_tar(export, ExportBounds())
            trusted = root / "trusted"
            reconstruct_trusted_checkout(base, exported, trusted)

            capture_patch(trusted)
            with self.assertRaisesRegex(ValueError, "freshly reconstructed"):
                capture_patch(trusted)
            exported.close()

    def test_implicit_directories_are_counted_and_traversable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "export.tar"
            member = tarfile.TarInfo("one/two/file")
            member.uid = member.gid = 65532
            member.size = 1
            with tarfile.open(archive, "w") as output:
                output.addfile(member, io.BytesIO(b"x"))
            exported = validate_exported_tar(archive, ExportBounds(max_files=3))
            self.assertEqual(exported.file_count, 3)
            root_path = staging_root(exported)
            self.assertEqual((root_path / "one").stat().st_mode & 0o777, 0o755)
            self.assertEqual((root_path / "one" / "two").stat().st_mode & 0o777, 0o755)
            exported.close()

    def test_non_utf8_text_is_recaptured_as_an_applicable_binary_patch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            agent = root / "agent"
            target = root / "target"
            trusted = root / "trusted"
            initialize_repository(base)
            (base / "changed.txt").write_bytes(b"before\n")
            git(base, "add", "changed.txt")
            git(base, "commit", "-qm", "binary-like base")
            git(root, "clone", "-q", str(base), str(agent))
            git(root, "clone", "-q", str(base), str(target))
            (agent / "changed.txt").write_bytes(b"\xffafter\n")
            export = root / "export.tar"
            archive_worktree(agent, export)
            exported = validate_exported_tar(export, ExportBounds())
            reconstruct_trusted_checkout(base, exported, trusted)

            patch = capture_patch(trusted)
            patch.decode("utf-8")
            self.assertIn(b"GIT binary patch", patch)
            git(target, "apply", "--binary", "-", input=patch)
            self.assertEqual((target / "changed.txt").read_bytes(), b"\xffafter\n")
            exported.close()

    def test_reconstruction_rejects_staging_mutation_after_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            initialize_repository(base)
            export = root / "export.tar"
            archive_worktree(base, export)
            exported = validate_exported_tar(export, ExportBounds())
            staged = staging_root(exported) / "changed.txt"
            staged.write_bytes(b"evil\n")

            with self.assertRaisesRegex(RuntimeError, "changed|digest|size"):
                reconstruct_trusted_checkout(base, exported, root / "trusted")
            exported.close()

    def test_capture_is_immune_to_trusted_checkout_mutation_after_reconstruction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            agent = root / "agent"
            target = root / "target"
            trusted = root / "trusted"
            initialize_repository(base)
            git(root, "clone", "-q", str(base), str(agent))
            git(root, "clone", "-q", str(base), str(target))
            (agent / "changed.txt").write_text("exported\n")
            export = root / "export.tar"
            archive_worktree(agent, export)
            exported = validate_exported_tar(export, ExportBounds())
            reconstruct_trusted_checkout(base, exported, trusted)
            (trusted / "changed.txt").write_text("mutated later\n")

            patch = capture_patch(trusted)
            git(target, "apply", "--binary", "-", input=patch)
            self.assertEqual((target / "changed.txt").read_text(), "exported\n")
            exported.close()

    def test_capture_includes_exported_files_even_when_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            agent = root / "agent"
            target = root / "target"
            trusted = root / "trusted"
            initialize_repository(base)
            git(root, "clone", "-q", str(base), str(agent))
            git(root, "clone", "-q", str(base), str(target))
            (agent / "ignored.bin").write_bytes(b"\0ignored but exported\n")
            export = root / "export.tar"
            archive_worktree(agent, export)
            exported = validate_exported_tar(export, ExportBounds())
            reconstruct_trusted_checkout(base, exported, trusted)

            patch = capture_patch(trusted)
            git(target, "apply", "--binary", "-", input=patch)
            self.assertEqual((target / "ignored.bin").read_bytes(), b"\0ignored but exported\n")
            exported.close()

    def test_patch_output_limit_fails_before_returning_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            agent = root / "agent"
            initialize_repository(base)
            git(root, "clone", "-q", str(base), str(agent))
            (agent / "changed.txt").write_text("a much larger changed value\n")
            export = root / "export.tar"
            archive_worktree(agent, export)
            exported = validate_exported_tar(export, ExportBounds())

            with mock.patch.object(checkout_module, "_patch_limit", return_value=32):
                with self.assertRaisesRegex(RuntimeError, "patch output.*bound"):
                    reconstruct_trusted_checkout(base, exported, root / "trusted")
            exported.close()

    def test_reconstructs_complete_tree_and_patch_applies_to_another_clean_clone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            agent = root / "agent"
            trusted = root / "trusted"
            target = root / "target"
            initialize_repository(base)
            git(root, "clone", "-q", str(base), str(agent))
            git(root, "clone", "-q", str(base), str(target))

            (agent / "changed.txt").write_text("staged\n")
            git(agent, "add", "changed.txt")
            (agent / "mixed.txt").write_text("staged\n")
            git(agent, "add", "mixed.txt")
            (agent / "mixed.txt").write_text("staged\nunstaged\n")
            (agent / "new.txt").write_text("untracked\n")
            (agent / "binary.bin").write_bytes(bytes(range(256)) * 8)
            (agent / "ignored.bin").write_bytes(b"ignored\n")
            (agent / "deleted.txt").unlink()
            (agent / "safe-link").symlink_to("new.txt")
            export = root / "agent.tar"
            archive_worktree(agent, export)

            exported = validate_exported_tar(export, ExportBounds())
            with mock.patch.object(
                checkout_module.subprocess,
                "run",
                wraps=subprocess.run,
            ) as run:
                reconstruct_trusted_checkout(base, exported, trusted)
                patch = capture_patch(trusted)
            git(target, "apply", "--binary", "-", input=patch)

            self.assertEqual((target / "changed.txt").read_text(), "staged\n")
            self.assertEqual((target / "mixed.txt").read_text(), "staged\nunstaged\n")
            self.assertEqual((target / "new.txt").read_text(), "untracked\n")
            self.assertEqual((target / "binary.bin").read_bytes(), bytes(range(256)) * 8)
            self.assertFalse((target / "deleted.txt").exists())
            self.assertTrue((target / "safe-link").is_symlink())
            self.assertEqual(os.readlink(target / "safe-link"), "new.txt")
            self.assertEqual((target / "ignored.bin").read_bytes(), b"ignored\n")
            self.assertIn(b"GIT binary patch", patch)
            for call in run.call_args_list:
                command = call.args[0]
                self.assertEqual(command[0], "/usr/bin/git")
                self.assertEqual(
                    command[1:5],
                    ["-c", "core.hooksPath=/dev/null", "-c", "diff.external="],
                )
                self.assertEqual(dict(call.kwargs["env"]), dict(checkout_module.FIXED_GIT_ENV))
            exported.close()

    def test_twenty_thousand_files_use_constant_git_process_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            initialize_repository(base)
            archive = root / "export.tar"
            with tarfile.open(archive, "w") as output:
                for index in range(20_000):
                    member = tarfile.TarInfo(f"generated/file-{index:05d}")
                    member.uid = member.gid = 65532
                    output.addfile(member, io.BytesIO())
            exported = validate_exported_tar(archive, ExportBounds(max_files=20_001))
            trusted = root / "trusted"

            real_popen = subprocess.Popen
            commands = []

            def recording_popen(*args, **kwargs):
                commands.append(args[0])
                return real_popen(*args, **kwargs)

            with mock.patch.object(
                checkout_module.subprocess,
                "Popen",
                side_effect=recording_popen,
            ):
                reconstruct_trusted_checkout(base, exported, trusted)
            self.assertEqual(len([command for command in commands if "add" in command]), 1)
            self.assertEqual(len([command for command in commands if "diff" in command]), 1)
            exported.close()

    def test_agent_git_metadata_is_rejected_and_never_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "agent.tar"
            member = tarfile.TarInfo(".git/hooks/post-checkout")
            content = b"#!/bin/sh\nexit 99\n"
            member.size = len(content)
            member.mode = 0o755
            with tarfile.open(archive, "w") as output:
                output.addfile(member, io.BytesIO(content))

            with self.assertRaisesRegex(ValueError, "Git metadata"):
                validate_exported_tar(archive, ExportBounds())


if __name__ == "__main__":
    unittest.main()
