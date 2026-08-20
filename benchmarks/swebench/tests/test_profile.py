import json
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path

from benchmarks.swebench.profile import load_profile


REPO_ROOT = Path(__file__).parents[3]
PROFILE_PATH = Path(__file__).parents[1] / "profile.json"
SECCOMP_PATH = PROFILE_PATH.parent / "policies" / "untrusted-seccomp.json"


class ProfileTests(unittest.TestCase):
    def test_profile_loads_all_reviewed_pins(self):
        profile = load_profile(PROFILE_PATH, REPO_ROOT)

        self.assertEqual(profile.canonical_repository, "https://github.com/ccoussa717/alloy.git")
        self.assertEqual(profile.dataset.name, "SWE-bench/SWE-bench_Lite")
        self.assertEqual(profile.dataset.split, "test")
        self.assertEqual(profile.dataset.revision, "b0dde1093fe417d83b7184254edf8199c1f0dff5")
        self.assertEqual(
            profile.dataset.parquet_sha256,
            "438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3",
        )
        self.assertEqual(
            profile.dataset.row_sha256,
            "36373ba1246adbb171a59ae30b6b7fe4a1d437d5cd92cb1e2c3a51bc549b6153",
        )
        self.assertEqual(profile.dataset.instance_id, "astropy__astropy-12907")
        self.assertEqual(profile.dataset.base_commit, "d16bfe05a744909de4b27f5875fe0d4ed41ce607")
        self.assertEqual(
            profile.evaluator_image.manifest_digest,
            "sha256:7485c1e3c8861efd0c6a4a78b952857592e541031039000d25e9481f045dc4a3",
        )
        self.assertEqual(profile.evaluator.python_version, "3.14.4")
        self.assertEqual(
            profile.evaluator.requirements_lock_sha256,
            "7a316d1f9f8df01f307192b77e0581647b12d56a0dc2856c90119b13314b5720",
        )
        self.assertEqual(
            profile.evaluator.upstream_run_evaluation_sha256,
            "9b3dc406fab87fe2901cea91aa02d594bd7b2a12dc011fa294bb784ea0f145e6",
        )
        self.assertEqual(
            profile.evaluator.patched_run_evaluation_sha256,
            "e398d067dee9f4400c5822af7dbc20270f681b7bc6c43ab23b6cf6999cc1bf54",
        )
        self.assertEqual(profile.agent_image.platform, "linux/amd64")
        self.assertEqual(profile.proxy_image.platform, "linux/amd64")
        self.assertEqual(profile.evaluator_image.platform, "linux/amd64")
        self.assertEqual(
            profile.proxy.allowed_routes,
            (("GET", "/api/tags"), ("POST", "/api/show"), ("POST", "/v1/chat/completions")),
        )
        self.assertEqual(profile.limits.agent_timeout_seconds, 1800)
        self.assertEqual(profile.limits.evaluator_timeout_seconds, 2400)
        self.assertEqual(profile.limits.pids, 512)
        self.assertEqual(profile.limits.memory_bytes, 16 * 1024**3)
        self.assertEqual(profile.limits.cpus, 4)
        self.assertEqual(profile.limits.max_files, 20_000)
        self.assertEqual(profile.limits.max_file_bytes, 16 * 1024**2)
        self.assertEqual(profile.limits.max_export_bytes, 256 * 1024**2)
        self.assertEqual(
            profile.security_policy.seccomp_sha256,
            "b08e89ec087ebd1cc10996da70c6b632965f2c3708820e9e45a7c84d663a7cb4",
        )
        self.assertEqual(
            profile.security_policy.apparmor_sha256,
            "205bdc1b42fc317558e89e450f1810801b2db817e212f5701d07b5aa12799eeb",
        )

    def test_profile_dataclasses_are_frozen(self):
        profile = load_profile(PROFILE_PATH, REPO_ROOT)
        with self.assertRaises(FrozenInstanceError):
            profile.dataset.revision = "a" * 40

    def test_profile_rejects_unknown_and_missing_keys_at_every_level(self):
        reviewed = json.loads(PROFILE_PATH.read_text())
        cases = [
            ({**reviewed, "unexpected": True}, "unknown benchmark profile keys"),
            ({key: value for key, value in reviewed.items() if key != "proxy"}, "missing benchmark profile keys"),
        ]
        nested_objects = {
            "dataset": "revision",
            "agent_image": "platform",
            "proxy_image": "platform",
            "evaluator_image": "platform",
            "evaluator": "patch_sha256",
            "security_policy": "apparmor_name",
            "limits": "pids",
            "proxy": "allowed_routes",
        }
        for name, required_key in nested_objects.items():
            cases.extend(
                (
                    (
                        {**reviewed, name: {**reviewed[name], "unexpected": True}},
                        f"unknown {name} keys",
                    ),
                    (
                        {
                            **reviewed,
                            name: {
                                key: value
                                for key, value in reviewed[name].items()
                                if key != required_key
                            },
                        },
                        f"missing {name} keys",
                    ),
                )
            )
        for value, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "profile.json"
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, message):
                    load_profile(path, REPO_ROOT)

    def test_profile_rejects_malformed_hashes_images_platforms_limits_and_routes(self):
        reviewed = json.loads(PROFILE_PATH.read_text())
        cases = (
            (
                {**reviewed, "model_digest": "A" * 64},
                "model_digest must be a lowercase SHA-256",
            ),
            (
                {
                    **reviewed,
                    "evaluator_image": {
                        **reviewed["evaluator_image"],
                        "manifest_digest": "7485" + "a" * 60,
                    },
                },
                "manifest_digest must be a sha256 image manifest digest",
            ),
            (
                {
                    **reviewed,
                    "agent_image": {**reviewed["agent_image"], "reference": "node:latest"},
                },
                "reference must be digest-qualified",
            ),
            (
                {
                    **reviewed,
                    "proxy_image": {**reviewed["proxy_image"], "platform": "linux/arm64"},
                },
                "platform must be linux/amd64",
            ),
            (
                {**reviewed, "limits": {**reviewed["limits"], "pids": 0}},
                "limits.pids must be positive",
            ),
            (
                {
                    **reviewed,
                    "proxy": {
                        **reviewed["proxy"],
                        "allowed_routes": [["GET", "/api/tags"]],
                    },
                },
                "proxy.allowed_routes must equal the reviewed routes",
            ),
        )
        for value, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "profile.json"
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, message):
                    load_profile(path, REPO_ROOT)

    def test_profile_rejects_policy_file_hash_mismatches(self):
        cases = (
            ("untrusted-seccomp.json", "seccomp policy SHA-256 mismatch"),
            ("alloy-swebench-gate.apparmor", "AppArmor policy SHA-256 mismatch"),
        )
        for filename, message in cases:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as directory:
                authority_root = Path(directory)
                policy_root = authority_root / "benchmarks" / "swebench" / "policies"
                policy_root.mkdir(parents=True)
                source_root = PROFILE_PATH.parent / "policies"
                for source in source_root.iterdir():
                    shutil.copyfile(source, policy_root / source.name)
                (policy_root / filename).write_text("tampered\n")

                with self.assertRaisesRegex(ValueError, message):
                    load_profile(PROFILE_PATH, authority_root)

    def test_seccomp_filters_each_clone_namespace_flag_and_falls_back_from_clone3(self):
        policy = json.loads(SECCOMP_PATH.read_text())
        clone_rules = [
            rule
            for rule in policy["syscalls"]
            if rule["names"] == ["clone"]
        ]
        expected_flags = {
            0x80,
            0x00020000,
            0x02000000,
            0x04000000,
            0x08000000,
            0x10000000,
            0x20000000,
            0x40000000,
        }

        self.assertEqual(len(clone_rules), len(expected_flags))
        self.assertEqual(
            {
                (argument["value"], argument["valueTwo"])
                for rule in clone_rules
                for argument in rule["args"]
                if argument["index"] == 0
                and argument["op"] == "SCMP_CMP_MASKED_EQ"
            },
            {(flag, flag) for flag in expected_flags},
        )
        self.assertTrue(
            all(rule["action"] == "SCMP_ACT_ERRNO" and rule["errnoRet"] == 1 for rule in clone_rules)
        )
        self.assertFalse(
            any(
                "clone" in rule["names"] and "args" not in rule
                for rule in policy["syscalls"]
            )
        )

        clone3_rules = [rule for rule in policy["syscalls"] if rule["names"] == ["clone3"]]
        self.assertEqual(len(clone3_rules), 1)
        self.assertEqual(clone3_rules[0]["action"], "SCMP_ACT_ERRNO")
        self.assertEqual(clone3_rules[0]["errnoRet"], 38)

    def test_seccomp_allows_normal_process_and_thread_creation(self):
        if shutil.which("docker") is None:
            self.skipTest("Docker is unavailable")
        image = "node:22-bookworm"
        if subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        ).returncode != 0:
            self.skipTest(f"local test image {image} is unavailable")
        script = """
const { spawnSync } = require("child_process");
const { Worker } = require("worker_threads");
const child = spawnSync("/bin/true");
if (child.status !== 0) process.exit(2);
const worker = new Worker("", { eval: true });
worker.once("online", () => worker.terminate().then(() => process.exit(0)));
worker.once("error", error => { console.error(error); process.exit(3); });
"""
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--security-opt",
                f"seccomp={SECCOMP_PATH}",
                image,
                "node",
                "-e",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
