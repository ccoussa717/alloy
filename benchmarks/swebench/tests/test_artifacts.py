import json
import os
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from benchmarks.swebench.artifacts import ResultWriter


class ResultWriterTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.results_root = self.root / "results"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_creates_one_private_canonical_run_directory_and_owned_files(self):
        writer = ResultWriter(
            self.results_root,
            "run-001",
            max_file_bytes=1024,
            max_total_bytes=2048,
        )

        manifest = writer.write_json("manifest.json", {"z": 1, "message": "héllo"})
        log = writer.write_text("agent.log", "safe diagnostic\n")

        self.assertEqual(writer.run_dir, self.results_root.absolute() / "run-001")
        self.assertEqual(writer.run_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(manifest.parent, writer.run_dir)
        self.assertEqual(log.parent, writer.run_dir)
        self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            manifest.read_bytes(),
            json.dumps(
                {"z": 1, "message": "héllo"},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8"),
        )

    def test_rejects_symlinked_results_root_and_existing_run(self):
        actual = self.root / "actual-results"
        actual.mkdir()
        self.results_root.symlink_to(actual, target_is_directory=True)

        with self.assertRaisesRegex(ValueError, "symlink|directory"):
            ResultWriter(self.results_root, "run-001")
        self.assertEqual(list(actual.iterdir()), [])

        self.results_root.unlink()
        ResultWriter(self.results_root, "run-001")
        with self.assertRaisesRegex(FileExistsError, "run"):
            ResultWriter(self.results_root, "run-001")

    def test_destinations_are_simple_names_created_exclusively_without_following_links(self):
        writer = ResultWriter(self.results_root, "run-001")
        outside = self.root / "outside"
        outside.write_text("unchanged")
        (writer.run_dir / "linked.log").symlink_to(outside)

        for name in ("", ".", "../escape", "nested/file", "/absolute"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "name"):
                writer.write_text(name, "content")
        with self.assertRaises(FileExistsError):
            writer.write_text("linked.log", "replacement")
        self.assertEqual(outside.read_text(), "unchanged")

        writer.write_text("once.log", "first")
        with self.assertRaises(FileExistsError):
            writer.write_text("once.log", "second")

    def test_enforces_per_file_and_cumulative_byte_limits_before_creation(self):
        writer = ResultWriter(
            self.results_root,
            "run-001",
            max_file_bytes=5,
            max_total_bytes=7,
        )

        writer.write_text("first", "12345")
        with self.assertRaisesRegex(ValueError, "file size"):
            writer.write_text("large", "123456")
        with self.assertRaisesRegex(ValueError, "total size"):
            writer.write_text("total", "123")
        self.assertFalse((writer.run_dir / "large").exists())
        self.assertFalse((writer.run_dir / "total").exists())

    def test_copy_accepts_only_bounded_regular_nonsymlink_sources(self):
        writer = ResultWriter(
            self.results_root,
            "run-001",
            max_file_bytes=8,
            max_total_bytes=16,
        )
        source = self.root / "source.log"
        source.write_bytes(b"content")

        copied = writer.copy_regular_file("copied.log", source)
        self.assertEqual(copied.read_bytes(), b"content")
        self.assertEqual(copied.stat().st_mode & 0o777, 0o600)

        symlink = self.root / "source-link"
        symlink.symlink_to(source)
        with self.assertRaisesRegex(ValueError, "regular file"):
            writer.copy_regular_file("linked-copy", symlink)

        source_directory = self.root / "sources"
        source_directory.mkdir()
        nested_source = source_directory / "nested.log"
        nested_source.write_text("nested")
        linked_directory = self.root / "linked-sources"
        linked_directory.symlink_to(source_directory, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinked ancestors"):
            writer.copy_regular_file("ancestor-link-copy", linked_directory / nested_source.name)

        directory = self.root / "source-directory"
        directory.mkdir()
        with self.assertRaisesRegex(ValueError, "regular file"):
            writer.copy_regular_file("directory-copy", directory)

        oversized = self.root / "oversized"
        oversized.write_bytes(b"123456789")
        with self.assertRaisesRegex(ValueError, "file size"):
            writer.copy_regular_file("oversized-copy", oversized)

    def test_writer_fails_closed_after_a_persistence_error(self):
        writer = ResultWriter(self.results_root, "run-001")
        with unittest.mock.patch(
            "benchmarks.swebench.artifacts.os.fsync",
            side_effect=OSError("storage failure"),
        ):
            with self.assertRaisesRegex(OSError, "storage failure"):
                writer.write_text("failed.log", "content")

        with self.assertRaisesRegex(ValueError, "closed"):
            writer.write_text("unsafe-retry.log", "content")

    def test_output_creation_is_descriptor_relative_exclusive_nofollow_and_fsynced(self):
        writer = ResultWriter(self.results_root, "run-001")
        original_open = os.open
        original_fsync = os.fsync
        opened = []
        synced = []

        def recording_open(path, flags, mode=0o777, *, dir_fd=None):
            opened.append((path, flags, mode, dir_fd))
            return original_open(path, flags, mode, dir_fd=dir_fd)

        def recording_fsync(fd):
            synced.append(fd)
            return original_fsync(fd)

        with unittest.mock.patch("benchmarks.swebench.artifacts.os.open", recording_open), unittest.mock.patch(
            "benchmarks.swebench.artifacts.os.fsync", recording_fsync
        ):
            writer.write_text("output.log", "content")

        created = [entry for entry in opened if entry[1] & os.O_CREAT]
        self.assertEqual(len(created), 1)
        _, flags, mode, dir_fd = created[0]
        self.assertTrue(flags & os.O_EXCL)
        self.assertTrue(flags & os.O_NOFOLLOW)
        self.assertEqual(mode, 0o600)
        self.assertIsNotNone(dir_fd)
        self.assertGreaterEqual(len(synced), 2)


if __name__ == "__main__":
    unittest.main()
