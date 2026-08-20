from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from benchmarks.swebench.cleanup import CleanupUncertaintyError
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
    container_evidence: dict[str, object]
    teardown_evidence: dict[str, object]


@dataclass(frozen=True)
class EvaluationExecution:
    stdout: str
    stderr: str
    scratch: Path
    run_id: str
    container_evidence: dict[str, object]


class EvaluationCleanupError(CleanupUncertaintyError):
    def __init__(
        self, original_error: BaseException, cleanup_error: BaseException
    ) -> None:
        super().__init__(
            f"evaluator failed: {original_error}; evaluator teardown failed: {cleanup_error}",
            original_error=original_error,
            cleanup_errors=(cleanup_error,),
        )


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
        self._last_evaluator_handle: ContainerHandle | None = None
        self._last_teardown_evidence: dict[str, object] | None = None

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
        if installed != expected:
            raise RuntimeError("installed evaluator distributions do not equal requirements.lock")
        if expected.get("swebench") != self.profile.swebench_version:
            raise RuntimeError("locked SWE-bench version does not match the benchmark profile")
        self._apply_verified_patch()
        self.runtime.preflight()
        self._image_id = self.runtime.verify_local_image(self.profile.evaluator_image)

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

    def _run_evaluator(self, command: list[str]) -> EvaluationExecution:
        scratch = Path(tempfile.mkdtemp(prefix="alloy-evaluator-"))
        process: subprocess.Popen[str] | None = None
        try:
            command[command.index("--report_dir") + 1] = str(scratch)
            run_id = command[command.index("--run_id") + 1]
            policy = self.profile.security_policy
            if self._image_id is None:
                raise RuntimeError("local evaluator image was not verified")
            environment = {
                "HOME": str(scratch),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
                "DOCKER_HOST": "unix:///var/run/docker.sock",
                "SWEBENCH_EVALUATOR_IMAGE": self.profile.evaluator_image.reference,
                "SWEBENCH_EVALUATOR_IMAGE_DIGEST": self.profile.evaluator_image.manifest_digest,
                "SWEBENCH_EVALUATOR_IMAGE_ID": self._image_id,
                "SWEBENCH_SECCOMP_PATH": str(
                    self.authority_root / policy.seccomp_path
                ),
                "SWEBENCH_APPARMOR_NAME": policy.apparmor_name,
            }
            process = subprocess.Popen(
                command,
                cwd=scratch,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            deadline = time.monotonic() + self.profile.evaluator_timeout_seconds
            evidence = self._await_evaluator_evidence(run_id, process, deadline)
            try:
                stdout, stderr = process.communicate(
                    timeout=max(0.001, deadline - time.monotonic())
                )
            except subprocess.TimeoutExpired as error:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate()
                raise subprocess.TimeoutExpired(
                    command,
                    self.profile.evaluator_timeout_seconds,
                    output=stdout,
                    stderr=stderr,
                ) from error
            if process.returncode != 0:
                raise subprocess.CalledProcessError(
                    process.returncode, command, output=stdout, stderr=stderr
                )
            return EvaluationExecution(
                stdout, stderr, scratch, run_id, evidence
            )
        except BaseException:
            if process is not None and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
            shutil.rmtree(scratch)
            raise

    def _await_evaluator_evidence(
        self,
        run_id: str,
        process: subprocess.Popen[str],
        deadline: float,
    ) -> dict[str, object]:
        name = f"sweb.eval.{self.profile.instance_id.lower()}.{run_id}"
        pending = ContainerHandle(name, name, run_id)

        def observe() -> dict[str, object] | None:
            evidence = self.runtime.inspect_owned_container(pending, absent_ok=True)
            if evidence is None:
                return None
            self._validate_evaluator_evidence(evidence, run_id)
            self._last_evaluator_handle = ContainerHandle(
                name, str(evidence["container_id"]), run_id
            )
            return evidence

        while time.monotonic() < deadline:
            evidence = observe()
            if evidence is not None:
                return evidence
            returncode = process.poll()
            if returncode is not None:
                evidence = observe()
                if evidence is not None:
                    return evidence
                stdout, stderr = process.communicate()
                if returncode != 0:
                    raise subprocess.CalledProcessError(
                        returncode, process.args, output=stdout, stderr=stderr
                    )
                raise RuntimeError(
                    "evaluator exited before its container could be observed"
                )
            time.sleep(0.25)
        raise RuntimeError("evaluator container was never observed for trusted inspection")

    def _validate_evaluator_evidence(
        self, evidence: dict[str, object], run_id: str
    ) -> None:
        inspected = evidence.get("inspection")
        if not isinstance(inspected, dict):
            raise RuntimeError("evaluator container inspection evidence is invalid")
        config = inspected.get("Config")
        host = inspected.get("HostConfig")
        network = inspected.get("NetworkSettings")
        mounts = inspected.get("Mounts")
        if not all(isinstance(value, dict) for value in (config, host, network)):
            raise RuntimeError("evaluator container inspection evidence is incomplete")
        if not (
            isinstance(config, dict)
            and isinstance(host, dict)
            and isinstance(network, dict)
        ):
            raise RuntimeError("evaluator container inspection evidence is incomplete")
        labels = config.get("Labels")
        expected_security = {
            "no-new-privileges:true",
            f"seccomp={self.authority_root / self.profile.security_policy.seccomp_path}",
            f"apparmor={self.profile.security_policy.apparmor_name}",
        }
        security = {
            "no-new-privileges:true" if value == "no-new-privileges" else value
            for value in (host.get("SecurityOpt") or [])
        }
        expected_mount = {
            "Type": "volume",
            "Name": f"alloy-eval-workspace-{run_id}",
            "Destination": "/testbed",
            "RW": True,
        }
        if (
            config.get("User") != "65532:65532"
            or not isinstance(labels, dict)
            or labels.get("alloy.swebench.gate") != run_id
            or {str(value).upper() for value in (host.get("CapDrop") or [])} != {"ALL"}
            or host.get("Privileged") is not False
            or host.get("ReadonlyRootfs") is not True
            or host.get("Init") is not True
            or host.get("NetworkMode") != "none"
            or host.get("PidsLimit") != self.profile.limits.pids
            or host.get("Memory") != self.profile.limits.memory_bytes
            or host.get("NanoCpus") != self.profile.limits.cpus * 1_000_000_000
            or inspected.get("Image") != self._image_id
            or security != expected_security
            or set(network.get("Networks") or {}) not in (set(), {"none"})
            or not isinstance(mounts, list)
            or len(mounts) != 1
            or not isinstance(mounts[0], dict)
            or any(mounts[0].get(key) != value for key, value in expected_mount.items())
        ):
            raise RuntimeError("evaluator container inspection drifted")

    @staticmethod
    def _read_summary(execution: EvaluationExecution) -> dict[str, object]:
        summaries = list(execution.scratch.glob(f"*.{execution.run_id}.json"))
        if len(summaries) != 1:
            raise RuntimeError(f"official evaluator produced {len(summaries)} run summaries")
        summary = json.loads(summaries[0].read_text())
        if not isinstance(summary, dict) or summary.get("schema_version") != 2:
            raise RuntimeError("official evaluator produced an unsupported summary schema")
        return summary

    def _verify_and_teardown_container(self, run_id: str) -> dict[str, object]:
        name = f"sweb.eval.{self.profile.instance_id.lower()}.{run_id}"
        handle = self._last_evaluator_handle or ContainerHandle(name, name, run_id)
        self.runtime.force_remove(handle)
        self.runtime.assert_absent(handle)
        evidence = {
            "absent": True,
            "container_id": handle.container_id,
            "daemon_identity": (
                asdict(self.runtime._daemon_identity)
                if self.runtime._daemon_identity is not None
                else None
            ),
        }
        self._last_teardown_evidence = evidence
        return evidence

    def run(self, predictions: Path, dataset_json: Path, run_id: str) -> EvaluationResult:
        if not predictions.is_file() or not dataset_json.is_file():
            raise ValueError("predictions and local dataset JSON must be regular files")
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", run_id) is None:
            raise ValueError("run ID must be safe for an owned Docker resource name")
        self._last_evaluator_handle = None
        self._last_teardown_evidence = None
        self.verify()
        command = self._command(predictions, dataset_json, run_id, dataset_json.parent)
        execution = None
        primary_error: BaseException | None = None
        teardown_evidence: dict[str, object] | None = None
        try:
            try:
                execution = self._run_evaluator(command)
            except BaseException as error:
                primary_error = error
            try:
                teardown_evidence = self._verify_and_teardown_container(run_id)
            except BaseException as cleanup_error:
                if primary_error is not None:
                    raise EvaluationCleanupError(
                        primary_error, cleanup_error
                    ) from primary_error
                raise
            if primary_error is not None:
                raise primary_error
            assert execution is not None and teardown_evidence is not None
            summary = self._read_summary(execution)
            return EvaluationResult(
                execution.stdout,
                execution.stderr,
                summary,
                execution.container_evidence,
                teardown_evidence,
            )
        finally:
            if execution is not None:
                shutil.rmtree(execution.scratch)
