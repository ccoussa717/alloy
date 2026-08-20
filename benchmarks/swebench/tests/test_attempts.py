import base64
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

from benchmarks.swebench.attempts import (
    AttemptKey,
    GateSigner,
    SignedClaim,
    authorize_retry,
    claim_first_attempt,
    verify_claim,
)


class AttemptTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.private_key = self.root / "gate-key.pem"
        self.public_key = self.root / "gate-key.pub.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.private_key)],
            capture_output=True,
            check=True,
        )
        subprocess.run(
            [
                "openssl",
                "pkey",
                "-in",
                str(self.private_key),
                "-pubout",
                "-out",
                str(self.public_key),
            ],
            capture_output=True,
            check=True,
        )
        self.key = AttemptKey(
            candidate_commit="a" * 40,
            instance_id="astropy__astropy-12907",
            dataset_revision="b" * 40,
            row_sha256="c" * 64,
            model_digest="d" * 64,
            authority_profile_digest="e" * 64,
        )
        self.signer = GateSigner(self.private_key)
        self.state_dir = self.root / "state"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_first_claim_is_canonical_signed_ordinal_one_and_state_is_private(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)

        self.assertEqual(claim.key, self.key)
        self.assertEqual(claim.ordinal, 1)
        self.assertEqual(claim.reason, "initial attempt")
        self.assertEqual(self.state_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(list(self.state_dir.glob("*.claim.json"))), 1)
        claim_path = next(self.state_dir.glob("*.claim.json"))
        self.assertEqual(claim_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(claim_path.read_bytes(), claim.canonical_bytes())
        self.assertFalse(claim_path.read_bytes().endswith(b"\n"))
        self.assertEqual(
            claim.canonical_bytes(),
            json.dumps(
                claim.as_dict(),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8"),
        )
        verify_claim(claim, self.public_key, self.key, set())

    def test_claim_records_are_immutable(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)

        with self.assertRaises(FrozenInstanceError):
            claim.ordinal = 2
        with self.assertRaises(FrozenInstanceError):
            self.key.candidate_commit = "f" * 40

    def test_first_claim_is_exclusive_and_survives_process_crash(self):
        first = claim_first_attempt(self.state_dir, self.key, self.signer)

        with self.assertRaisesRegex(FileExistsError, "already claimed"):
            claim_first_attempt(self.state_dir, self.key, GateSigner(self.private_key))

        persisted = SignedClaim.from_bytes(next(self.state_dir.glob("*.claim.json")).read_bytes())
        self.assertEqual(persisted, first)
        verify_claim(persisted, self.public_key, self.key, set())

    def test_failed_atomic_publish_leaves_a_durable_fail_closed_reservation(self):
        with unittest.mock.patch(
            "benchmarks.swebench.attempts.os.replace",
            side_effect=OSError("simulated crash before rename"),
        ):
            with self.assertRaisesRegex(OSError, "simulated crash"):
                claim_first_attempt(self.state_dir, self.key, self.signer)

        reservations = list(self.state_dir.glob("*.reserved"))
        self.assertEqual(len(reservations), 1)
        self.assertEqual(reservations[0].stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(FileExistsError, "already claimed"):
            claim_first_attempt(self.state_dir, self.key, self.signer)

    def test_claim_creation_uses_exclusive_nofollow_files_and_atomic_publish(self):
        original_open = os.open
        original_replace = os.replace
        opened_flags = []
        replacements = []

        def recording_open(path, flags, mode=0o777, *, dir_fd=None):
            opened_flags.append((path, flags, mode, dir_fd))
            return original_open(path, flags, mode, dir_fd=dir_fd)

        def recording_replace(source, destination, *, src_dir_fd=None, dst_dir_fd=None):
            replacements.append((source, destination, src_dir_fd, dst_dir_fd))
            return original_replace(
                source,
                destination,
                src_dir_fd=src_dir_fd,
                dst_dir_fd=dst_dir_fd,
            )

        with unittest.mock.patch("benchmarks.swebench.attempts.os.open", recording_open), unittest.mock.patch(
            "benchmarks.swebench.attempts.os.replace", recording_replace
        ):
            claim_first_attempt(self.state_dir, self.key, self.signer)

        created = [
            entry
            for entry in opened_flags
            if entry[1] & os.O_CREAT
            and isinstance(entry[0], str)
            and (entry[0].endswith(".reserved") or entry[0].endswith(".tmp"))
        ]
        self.assertTrue(created)
        self.assertTrue(all(flags & os.O_EXCL for _, flags, _, _ in created))
        self.assertTrue(all(flags & os.O_NOFOLLOW for _, flags, _, _ in created))
        self.assertTrue(all(mode == 0o600 for _, _, mode, _ in created))
        self.assertTrue(all(dir_fd is not None for _, _, _, dir_fd in created))
        self.assertEqual(len(replacements), 1)
        self.assertIsNotNone(replacements[0][2])
        self.assertEqual(replacements[0][2], replacements[0][3])

    def test_retry_requires_first_claim_and_one_nonempty_explicit_reason(self):
        with self.assertRaisesRegex(FileNotFoundError, "first attempt"):
            authorize_retry(self.state_dir, self.key, "infrastructure failure", self.signer)

        claim_first_attempt(self.state_dir, self.key, self.signer)
        for reason in ("", "   "):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, "reason"):
                authorize_retry(self.state_dir, self.key, reason, self.signer)

        retry = authorize_retry(
            self.state_dir,
            self.key,
            "maintainer approved after evaluator infrastructure failure",
            self.signer,
        )
        self.assertEqual(retry.ordinal, 2)
        self.assertEqual(
            retry.reason,
            "maintainer approved after evaluator infrastructure failure",
        )
        with self.assertRaisesRegex(FileExistsError, "already authorized"):
            authorize_retry(self.state_dir, self.key, "another retry", self.signer)

    def test_verification_rejects_implicit_third_attempt_wrong_key_and_wrong_signature(self):
        claim_first_attempt(self.state_dir, self.key, self.signer)
        retry = authorize_retry(self.state_dir, self.key, "explicit retry", self.signer)
        consumed = set()

        with self.assertRaisesRegex(ValueError, "ordinal"):
            verify_claim(replace(retry, ordinal=3), self.public_key, self.key, consumed)
        self.assertEqual(consumed, set())

        with self.assertRaisesRegex(ValueError, "attempt key"):
            verify_claim(retry, self.public_key, replace(self.key, model_digest="f" * 64), consumed)
        self.assertEqual(consumed, set())

        signature = bytearray(base64.b64decode(retry.signature))
        signature[0] ^= 1
        forged = replace(retry, signature=base64.b64encode(signature).decode("ascii"))
        with self.assertRaisesRegex(ValueError, "signature"):
            verify_claim(forged, self.public_key, self.key, consumed)
        self.assertEqual(consumed, set())

        other_private = self.root / "other-key.pem"
        other_public = self.root / "other-key.pub.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(other_private)],
            capture_output=True,
            check=True,
        )
        subprocess.run(
            [
                "openssl",
                "pkey",
                "-in",
                str(other_private),
                "-pubout",
                "-out",
                str(other_public),
            ],
            capture_output=True,
            check=True,
        )
        with self.assertRaisesRegex(ValueError, "signature"):
            verify_claim(retry, other_public, self.key, consumed)
        self.assertEqual(consumed, set())

    def test_successful_verification_consumes_only_at_verification_and_rejects_replay(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        consumed = set()

        self.assertEqual(consumed, set())
        verify_claim(claim, self.public_key, self.key, consumed)
        self.assertEqual(consumed, {1})
        with self.assertRaisesRegex(ValueError, "already consumed"):
            verify_claim(claim, self.public_key, self.key, consumed)

    def test_rejects_symlinked_state_directory(self):
        actual = self.root / "actual-state"
        actual.mkdir()
        self.state_dir.symlink_to(actual, target_is_directory=True)

        with self.assertRaisesRegex(ValueError, "symlink|directory"):
            claim_first_attempt(self.state_dir, self.key, self.signer)
        self.assertEqual(list(actual.iterdir()), [])

    def test_rejects_signing_and_verification_keys_beneath_symlinked_ancestors(self):
        key_directory = self.root / "keys"
        key_directory.mkdir()
        moved_private = key_directory / self.private_key.name
        moved_public = key_directory / self.public_key.name
        self.private_key.replace(moved_private)
        self.public_key.replace(moved_public)
        linked_directory = self.root / "linked-keys"
        linked_directory.symlink_to(key_directory, target_is_directory=True)

        with self.assertRaisesRegex(ValueError, "symlinked ancestors"):
            claim_first_attempt(
                self.state_dir,
                self.key,
                GateSigner(linked_directory / moved_private.name),
            )

        claim = claim_first_attempt(self.state_dir, self.key, GateSigner(moved_private))
        with self.assertRaisesRegex(ValueError, "symlinked ancestors"):
            verify_claim(claim, linked_directory / moved_public.name, self.key, set())


if __name__ == "__main__":
    unittest.main()
