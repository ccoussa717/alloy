from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from benchmarks.swebench.containers import ContainerHandle, DockerRuntime
from benchmarks.swebench.profile import BenchmarkProfile


LOCK_ENTRY = re.compile(
    r"(?P<name>[a-z0-9][a-z0-9._-]*)==(?P<version>[^ ]+)"
    r"(?P<hashes>(?:\s+--hash=sha256:[0-9a-f]{64})+)"
)


def _normalized_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_distributions(path: Path) -> dict[str, str]:
    logical = re.sub(r"\\\n\s+", " ", path.read_text())
    distributions: dict[str, str] = {}
    for line in logical.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = LOCK_ENTRY.fullmatch(stripped)
        if match is None:
            raise RuntimeError(f"requirements lock contains an unpinned entry: {stripped}")
        name = _normalized_name(match.group("name"))
        if name in distributions:
            raise RuntimeError(f"requirements lock repeats distribution {name}")
        distributions[name] = match.group("version")
    if not distributions:
        raise RuntimeError("requirements lock is empty")
    return distributions


def install_locked_requirements(python: Path, lock_path: Path) -> None:
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--require-hashes",
            "-r",
            str(lock_path.resolve()),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


@dataclass(frozen=True)
class EvaluationResult:
    stdout: str
    stderr: str
    summary: dict[str, object]


class EvaluatorEnvironment:
    def __init__(
        self,
        profile: BenchmarkProfile,
        authority_root: Path,
        python: Path,
        *,
        runtime: DockerRuntime | None = None,
    ) -> None:
        self.profile = profile
        self.authority_root = authority_root.resolve()
        self.python = python.absolute()
        self.runtime = runtime or DockerRuntime(profile, self.authority_root)
        self.lock_path = (
            self.authority_root / profile.evaluator.requirements_lock_path
        ).resolve()
        self.patch_path = (self.authority_root / profile.evaluator.patch_path).resolve()
        self.source_path = (
            self.python.parent.parent
            / "lib"
            / f"python{profile.evaluator.python_version.rsplit('.', 1)[0]}"
            / "site-packages"
            / "swebench"
            / "harness"
            / "run_evaluation.py"
        )
        self._image_id: str | None = None

    @staticmethod
    def _sha256(path: Path) -> str:
        try:
            return hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise RuntimeError(f"required evaluator file is unavailable: {path}") from error

    def _installed_distributions(self) -> dict[str, str]:
        code = (
            "import importlib.metadata as m, json; "
            "print(json.dumps([(d.metadata['Name'], d.version) for d in m.distributions()]))"
        )
        result = subprocess.run(
            [str(self.python), "-c", code],
            check=True,
            capture_output=True,
            text=True,
        )
        value = json.loads(result.stdout)
        if not isinstance(value, list):
            raise RuntimeError("evaluator returned an invalid installed distribution set")
        installed: dict[str, str] = {}
        for item in value:
            if (
                not isinstance(item, list)
                or len(item) != 2
                or not isinstance(item[0], str)
                or not isinstance(item[1], str)
            ):
                raise RuntimeError("evaluator returned an invalid installed distribution set")
            name = _normalized_name(item[0])
            if name in installed:
                raise RuntimeError(f"evaluator contains duplicate distribution {name}")
            installed[name] = item[1]
        return installed

    def _apply_verified_patch(self) -> None:
        pin = self.profile.evaluator
        observed = self._sha256(self.source_path)
        if observed == pin.patched_run_evaluation_sha256:
            return
        if observed != pin.upstream_run_evaluation_sha256:
            raise RuntimeError("upstream run_evaluation.py SHA-256 mismatch")
        if self._sha256(self.patch_path) != pin.patch_sha256:
            raise RuntimeError("evaluator confinement patch SHA-256 mismatch")
        site_packages = self.source_path.parents[2]
        subprocess.run(
            [
                "/usr/bin/patch",
                "--batch",
                "--forward",
                "--fuzz=0",
                "--strip=1",
                "--input",
                str(self.patch_path),
            ],
            cwd=site_packages,
            check=True,
            capture_output=True,
            text=True,
        )
        if self._sha256(self.source_path) != pin.patched_run_evaluation_sha256:
            raise RuntimeError("patched run_evaluation.py SHA-256 mismatch")

    def verify(self) -> None:
        pin = self.profile.evaluator
        version = subprocess.run(
            [str(self.python), "--version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if version != f"Python {pin.python_version}":
            raise RuntimeError(
                f"evaluator Python drift: expected {pin.python_version}, observed {version}"
            )
        if self._sha256(self.lock_path) != pin.requirements_lock_sha256:
            raise RuntimeError("evaluator requirements lock SHA-256 mismatch")
        expected = locked_distributions(self.lock_path)
        installed = self._installed_distributions()
        bootstrap = {name: version for name, version in installed.items() if name == "pip"}
        if {name: version for name, version in installed.items() if name not in bootstrap} != expected:
            raise RuntimeError("installed evaluator distributions do not equal requirements.lock")
        if expected.get("swebench") != self.profile.swebench_version:
            raise RuntimeError("locked SWE-bench version does not match the benchmark profile")
        self._apply_verified_patch()
        self.runtime.preflight()
        self._image_id = self.runtime.pull_and_verify(self.profile.evaluator_image)

    def _command(
        self, predictions: Path, dataset_json: Path, run_id: str, report_dir: Path
    ) -> list[str]:
        return [
            str(self.python),
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            str(dataset_json.resolve()),
            "--split",
            self.profile.split,
            "--instance_ids",
            self.profile.instance_id,
            "--predictions_path",
            str(predictions.resolve()),
            "--max_workers",
            "1",
            "--timeout",
            str(self.profile.agent_timeout_seconds),
            "--run_id",
            run_id,
            "--report_dir",
            str(report_dir),
            "--no_pull",
        ]

    def _run_evaluator(self, command: list[str]) -> tuple[str, str, dict[str, object]]:
        with tempfile.TemporaryDirectory(prefix="alloy-evaluator-") as directory:
            scratch = Path(directory)
            command[command.index("--report_dir") + 1] = str(scratch)
            policy = self.profile.security_policy
            environment = {
                "HOME": str(scratch),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
                "DOCKER_HOST": "unix:///var/run/docker.sock",
                "SWEBENCH_EVALUATOR_IMAGE": self.profile.evaluator_image.reference,
                "SWEBENCH_EVALUATOR_IMAGE_DIGEST": self.profile.evaluator_image.manifest_digest,
                "SWEBENCH_SECCOMP_PATH": str(
                    self.authority_root / policy.seccomp_path
                ),
                "SWEBENCH_APPARMOR_NAME": policy.apparmor_name,
            }
            completed = subprocess.run(
                command,
                cwd=scratch,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
                timeout=self.profile.evaluator_timeout_seconds,
            )
            summaries = list(scratch.glob(f"*.{command[command.index('--run_id') + 1]}.json"))
            if len(summaries) != 1:
                raise RuntimeError(f"official evaluator produced {len(summaries)} run summaries")
            summary = json.loads(summaries[0].read_text())
            if not isinstance(summary, dict):
                raise RuntimeError("official evaluator summary must be an object")
            return completed.stdout, completed.stderr, summary

    def _verify_and_teardown_container(self, run_id: str) -> None:
        name = f"sweb.eval.{self.profile.instance_id.lower()}.{run_id}"
        self.runtime.force_remove(ContainerHandle(name, name, run_id))

    def run(self, predictions: Path, dataset_json: Path, run_id: str) -> EvaluationResult:
        if not predictions.is_file() or not dataset_json.is_file():
            raise ValueError("predictions and local dataset JSON must be regular files")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", run_id) is None:
            raise ValueError("run ID must be safe for an owned Docker resource name")
        self.verify()
        command = self._command(predictions, dataset_json, run_id, dataset_json.parent)
        try:
            stdout, stderr, summary_value = self._run_evaluator(command)
        finally:
            self._verify_and_teardown_container(run_id)
        if isinstance(summary_value, Path):
            summary_value = json.loads(summary_value.read_text())
        if not isinstance(summary_value, dict) or summary_value.get("schema_version") != 2:
            raise RuntimeError("official evaluator produced an unsupported summary schema")
        return EvaluationResult(stdout, stderr, summary_value)
