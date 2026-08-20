import hashlib
import importlib.util
import io
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.swebench.dataset import (
    canonical_json_bytes,
    dataset_url,
    fetch_and_verify_instance,
    prompt_instance,
    write_private_dataset_json,
)
from benchmarks.swebench.profile import load_profile


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
PROFILE = load_profile(PROFILE_PATH, REPO_ROOT)


class CanonicalJsonTests(unittest.TestCase):
    def test_canonical_json_bytes_are_stable_utf8_without_newline(self):
        self.assertEqual(
            canonical_json_bytes({"z": "café", "a": [True, None, 1.5]}),
            b'{"a":[true,null,1.5],"z":"caf\xc3\xa9"}',
        )

    def test_canonical_json_rejects_nonfinite_numbers_and_nonstring_keys(self):
        for value in ({"value": math.nan}, {"value": math.inf}, {1: "value"}):
            with self.subTest(value=value), self.assertRaises((TypeError, ValueError)):
                canonical_json_bytes(value)


class DatasetIntegrityTests(unittest.TestCase):
    def test_profile_uses_exact_revision_url_and_reviewed_hashes(self):
        self.assertEqual(
            dataset_url(PROFILE),
            "https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite/resolve/"
            "b0dde1093fe417d83b7184254edf8199c1f0dff5/"
            "data/test-00000-of-00001.parquet",
        )
        self.assertEqual(
            PROFILE.dataset.parquet_sha256,
            "438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3",
        )
        self.assertEqual(
            PROFILE.dataset.row_sha256,
            "36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153",
        )

    @unittest.skipUnless(importlib.util.find_spec("pyarrow"), "pyarrow is installed in the evaluator venv")
    def test_verified_row_is_exactly_7104_canonical_bytes_and_gold_is_copy_only(self):
        with tempfile.TemporaryDirectory() as directory:
            row = fetch_and_verify_instance(Path(directory), PROFILE)

        encoded = canonical_json_bytes(row)
        self.assertEqual(len(encoded), 7104)
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), PROFILE.dataset.row_sha256)
        self.assertIn("patch", row)
        self.assertIn("test_patch", row)
        public = prompt_instance(row)
        self.assertNotIn("patch", public)
        self.assertNotIn("test_patch", public)
        self.assertIn("patch", row)
        self.assertIn("test_patch", row)

    def test_download_hash_is_checked_before_cache_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            response = io.BytesIO(b"tampered parquet")
            with mock.patch("benchmarks.swebench.dataset._open_url", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "parquet SHA-256"):
                    fetch_and_verify_instance(cache, PROFILE)
            self.assertEqual(list(cache.iterdir()), [])

    def test_private_dataset_json_contains_full_row_at_mode_0600(self):
        row = {"instance_id": PROFILE.instance_id, "patch": "gold", "test_patch": "tests"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dataset.json"
            write_private_dataset_json(path, row)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), [row])


if __name__ == "__main__":
    unittest.main()
