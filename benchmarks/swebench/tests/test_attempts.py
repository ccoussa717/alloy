import base64
import errno
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import unittest
import unittest.mock
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import benchmarks.swebench.attempts as attempts_module
from benchmarks.swebench.attempts import (
    AttemptKey,
    ConsumptionUncertainError,
    GateSigner,
    SignedClaim,
    authorize_retry,
    claim_first_attempt,
    consume_claim,
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

    def assert_no_consumption_temps(self):
        self.assertEqual(list(self.state_dir.glob(".*.consumed.*.tmp")), [])

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
        verify_claim(claim, self.public_key, self.key)

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
        verify_claim(persisted, self.public_key, self.key)

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
        with self.assertRaisesRegex(ValueError, "ordinal"):
            verify_claim(replace(retry, ordinal=3), self.public_key, self.key)

        with self.assertRaisesRegex(ValueError, "attempt key"):
            verify_claim(retry, self.public_key, replace(self.key, model_digest="f" * 64))

        signature = bytearray(base64.b64decode(retry.signature))
        signature[0] ^= 1
        forged = replace(retry, signature=base64.b64encode(signature).decode("ascii"))
        with self.assertRaisesRegex(ValueError, "signature"):
            verify_claim(forged, self.public_key, self.key)

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
            verify_claim(retry, other_public, self.key)

    def test_verification_is_repeatable_and_consumption_is_atomic_at_launch(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)

        verify_claim(claim, self.public_key, self.key)
        verify_claim(claim, self.public_key, self.key)
        self.assertEqual(list(self.state_dir.glob("*.consumed")), [])

        original_open = os.open
        created = []
        links = []

        def recording_open(path, flags, mode=0o777, *, dir_fd=None):
            if isinstance(path, str) and ".consumed." in path and path.endswith(".tmp"):
                created.append((path, flags, mode, dir_fd))
            return original_open(path, flags, mode, dir_fd=dir_fd)

        original_link = os.link

        def recording_link(source, destination, **kwargs):
            links.append((source, destination, kwargs))
            return original_link(source, destination, **kwargs)

        with unittest.mock.patch("benchmarks.swebench.attempts.os.open", recording_open), unittest.mock.patch(
            "benchmarks.swebench.attempts.os.link", recording_link
        ):
            consume_claim(self.state_dir, claim, self.public_key, self.key)

        self.assertEqual(len(created), 1)
        _, flags, mode, dir_fd = created[0]
        self.assertTrue(flags & os.O_EXCL)
        self.assertTrue(flags & os.O_NOFOLLOW)
        self.assertEqual(mode, 0o600)
        self.assertIsNotNone(dir_fd)
        self.assertEqual(len(links), 1)
        self.assertTrue(links[0][1].endswith(".consumed"))
        self.assertFalse(links[0][2]["follow_symlinks"])
        consumed = list(self.state_dir.glob("*.consumed"))
        self.assertEqual(len(consumed), 1)
        self.assertEqual(consumed[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            consumed[0].read_bytes(),
            hashlib.sha256(claim.canonical_bytes()).hexdigest().encode("ascii"),
        )
        self.assert_no_consumption_temps()
        verify_claim(claim, self.public_key, self.key)
        with self.assertRaisesRegex(FileExistsError, "already consumed"):
            consume_claim(self.state_dir, claim, self.public_key, self.key)
        self.assert_no_consumption_temps()

    def test_consumption_write_failure_removes_temp_without_publishing(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        marker = hashlib.sha256(claim.canonical_bytes()).hexdigest().encode("ascii")
        original_write_all = attempts_module._write_all

        def fail_marker_write(fd, content):
            if content == marker:
                raise OSError("marker write failed")
            return original_write_all(fd, content)

        with unittest.mock.patch("benchmarks.swebench.attempts._write_all", fail_marker_write):
            with self.assertRaisesRegex(OSError, "marker write failed"):
                consume_claim(self.state_dir, claim, self.public_key, self.key)

        self.assertEqual(list(self.state_dir.glob("*.consumed")), [])
        self.assert_no_consumption_temps()

    def test_consumption_file_fsync_failure_removes_temp_without_publishing(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        original_fsync = os.fsync

        def fail_temp_fsync(fd):
            target = os.readlink(f"/proc/self/fd/{fd}")
            if ".consumed." in target and target.endswith(".tmp"):
                raise OSError("marker fsync failed")
            return original_fsync(fd)

        with unittest.mock.patch("benchmarks.swebench.attempts.os.fsync", fail_temp_fsync):
            with self.assertRaisesRegex(OSError, "marker fsync failed"):
                consume_claim(self.state_dir, claim, self.public_key, self.key)

        self.assertEqual(list(self.state_dir.glob("*.consumed")), [])
        self.assert_no_consumption_temps()

    def test_consumption_directory_fsync_failure_rolls_back_and_fsyncs_cleanup(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        original_fsync = os.fsync
        directory_calls = 0

        def fail_first_directory_fsync(fd):
            nonlocal directory_calls
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                directory_calls += 1
                if directory_calls == 1:
                    raise OSError("publication fsync failed")
            return original_fsync(fd)

        with unittest.mock.patch("benchmarks.swebench.attempts.os.fsync", fail_first_directory_fsync):
            with self.assertRaisesRegex(OSError, "publication fsync failed"):
                consume_claim(self.state_dir, claim, self.public_key, self.key)

        self.assertGreaterEqual(directory_calls, 2)
        self.assertEqual(list(self.state_dir.glob("*.consumed")), [])
        self.assert_no_consumption_temps()
        consume_claim(self.state_dir, claim, self.public_key, self.key)

    def test_consumption_rollback_uncertainty_fails_closed(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        original_fsync = os.fsync

        def fail_directory_fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("directory storage failed")
            return original_fsync(fd)

        with unittest.mock.patch("benchmarks.swebench.attempts.os.fsync", fail_directory_fsync):
            with self.assertRaisesRegex(ConsumptionUncertainError, "uncertain"):
                consume_claim(self.state_dir, claim, self.public_key, self.key)

    def test_failed_verification_never_consumes_an_ordinal(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        forged = replace(claim, key=replace(self.key, model_digest="f" * 64))

        with self.assertRaisesRegex(ValueError, "attempt key"):
            verify_claim(forged, self.public_key, self.key)
        with self.assertRaisesRegex(ValueError, "attempt key"):
            consume_claim(self.state_dir, forged, self.public_key, self.key)

        self.assertEqual(list(self.state_dir.glob("*.consumed")), [])
        consume_claim(self.state_dir, claim, self.public_key, self.key)

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
            verify_claim(claim, linked_directory / moved_public.name, self.key)

    def test_openssl_uses_only_sealed_anonymous_payload_descriptors(self):
        payload = b'{"canonical":true}'
        before = set(self.root.rglob("*"))
        observed = []

        def inspect_signing_command(arguments, **kwargs):
            self.assertNotIn("input", kwargs)
            for option in ("-in",):
                path = arguments[arguments.index(option) + 1]
                self.assertRegex(path, r"^/proc/self/fd/\d+$")
                fd = int(path.rsplit("/", 1)[1])
                seals = fcntl.fcntl(fd, fcntl.F_GET_SEALS)
                expected = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
                self.assertEqual(seals & expected, expected)
                os.lseek(fd, 0, os.SEEK_SET)
                observed.append(os.read(fd, 4096))
                with self.assertRaises(OSError) as raised:
                    os.write(fd, b"tamper")
                self.assertEqual(raised.exception.errno, errno.EPERM)
            return subprocess.CompletedProcess(arguments, 0, stdout=b"signature", stderr=b"")

        with unittest.mock.patch("benchmarks.swebench.attempts.subprocess.run", inspect_signing_command):
            signature = self.signer.sign(payload)

        self.assertEqual(signature, b"signature")
        self.assertEqual(observed, [payload])
        self.assertEqual(set(self.root.rglob("*")), before)

    def test_verification_uses_sealed_memfds_for_payload_and_signature(self):
        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        observed = {}

        def inspect_verification_command(arguments, **kwargs):
            for option in ("-in", "-sigfile"):
                path = arguments[arguments.index(option) + 1]
                self.assertRegex(path, r"^/proc/self/fd/\d+$")
                fd = int(path.rsplit("/", 1)[1])
                seals = fcntl.fcntl(fd, fcntl.F_GET_SEALS)
                expected = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
                self.assertEqual(seals & expected, expected)
                os.lseek(fd, 0, os.SEEK_SET)
                observed[option] = os.read(fd, 4096)
            return subprocess.CompletedProcess(arguments, 0, stdout=b"Signature Verified Successfully", stderr=b"")

        with unittest.mock.patch("benchmarks.swebench.attempts.subprocess.run", inspect_verification_command):
            verify_claim(claim, self.public_key, self.key)

        self.assertEqual(observed["-in"], claim.signing_bytes())
        self.assertEqual(observed["-sigfile"], base64.b64decode(claim.signature))

    def test_official_crypto_fails_closed_when_sealed_memfd_is_unavailable(self):
        with unittest.mock.patch(
            "benchmarks.swebench.attempts.os.memfd_create",
            side_effect=OSError(errno.ENOSYS, "memfd unavailable"),
        ):
            with self.assertRaisesRegex(ValueError, "sealed memfd"):
                self.signer.sign(b"payload")

        claim = claim_first_attempt(self.state_dir, self.key, self.signer)
        with unittest.mock.patch(
            "benchmarks.swebench.attempts.os.memfd_create",
            side_effect=OSError(errno.ENOSYS, "memfd unavailable"),
        ):
            with self.assertRaisesRegex(ValueError, "sealed memfd"):
                verify_claim(claim, self.public_key, self.key)


if __name__ == "__main__":
    unittest.main()
