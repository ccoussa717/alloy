from __future__ import annotations

import base64
import copy
import hashlib
import json
import re
import secrets
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Protocol

from benchmarks.swebench.artifacts import ResultWriter
from benchmarks.swebench.attempts import (
    AttemptKey,
    GateSigner,
    SignedClaim,
    claim_first_attempt,
    consume_claim,
    verify_claim,
)
from benchmarks.swebench.authority import (
    HostConfig,
    coordinator_tree_digest,
    load_policy_from_commit,
    verify_candidate,
)
from benchmarks.swebench.checkout import (
    ExportBounds,
    capture_patch,
    reconstruct_trusted_checkout,
    validate_exported_tar,
)
from benchmarks.swebench.cleanup import (
    classify_cleanup_uncertainty,
    flatten_cleanup_failures,
)
from benchmarks.swebench.containers import (
    CleanupUncertainError,
    ContainerHandle,
    ContainerSpec,
    DockerRuntime,
    MountSpec,
)
from benchmarks.swebench.dataset import (
    canonical_json_bytes,
    fetch_and_verify_instance,
    prompt_instance,
    write_private_dataset_json,
)
from benchmarks.swebench.evaluator import (
    EvaluationResult,
    EvaluatorEnvironment,
)
from benchmarks.swebench.fetch import ArtifactFetcher
from benchmarks.swebench.install import (
    FetchedCandidate,
    PreparedTarget,
    VerifiedCandidateInstall,
    install_candidate,
    prepare_target,
)
from benchmarks.swebench.profile import BenchmarkProfile
from benchmarks.swebench.proxy import ProxyEndpoint, ProxyNetwork


EXPECTED_RELEASE_PHASES = (
    "authority",
    "candidate",
    "integrity_preflight",
    "candidate_install",
    "target_setup",
    "attempt_claim",
    "proxy_start",
    "agent_start",
    "agent_teardown",
    "patch_capture",
    "evaluation",
    "evaluation_teardown",
    "cleanup",
    "sign_results",
)

_EXIT_CODES = {
    "dry_run": 0,
    "evaluated": 0,
    "runtime_failure": 2,
    "dataset_failure": 3,
    "checkout_failure": 4,
    "agent_timeout": 5,
    "agent_failure": 6,
    "patch_capture_failure": 7,
    "evaluator_timeout": 8,
    "evaluator_failure": 8,
}
_FAILURE_STATUS = {
    "authority": "runtime_failure",
    "candidate": "runtime_failure",
    "integrity_preflight": "runtime_failure",
    "candidate_install": "runtime_failure",
    "target_setup": "checkout_failure",
    "attempt_claim": "runtime_failure",
    "proxy_start": "runtime_failure",
    "agent_start": "agent_failure",
    "agent_teardown": "agent_failure",
    "patch_capture": "patch_capture_failure",
    "evaluation": "evaluator_failure",
    "evaluation_teardown": "evaluator_failure",
    "sign_results": "runtime_failure",
    "cleanup": "runtime_failure",
}
_GIT_SHA = re.compile(r"[0-9a-f]{40}")
COORDINATOR_PATHS = (
    "benchmarks/swebench/artifacts.py",
    "benchmarks/swebench/attempts.py",
    "benchmarks/swebench/authority.py",
    "benchmarks/swebench/checkout.py",
    "benchmarks/swebench/cleanup.py",
    "benchmarks/swebench/containers.py",
    "benchmarks/swebench/coordinator.py",
    "benchmarks/swebench/dataset.py",
    "benchmarks/swebench/evaluator.py",
    "benchmarks/swebench/fetch.py",
    "benchmarks/swebench/install.py",
    "benchmarks/swebench/patches/swebench-5.0.0-run-evaluation.patch",
    "benchmarks/swebench/policies/alloy-swebench-gate.apparmor",
    "benchmarks/swebench/policies/untrusted-seccomp.json",
    "benchmarks/swebench/profile.json",
    "benchmarks/swebench/profile.py",
    "benchmarks/swebench/proxy.py",
    "benchmarks/swebench/proxy_server.py",
    "benchmarks/swebench/release-transform.json",
    "benchmarks/swebench/requirements.lock",
    "benchmarks/swebench/runner.py",
)


class CoordinatorFailure(RuntimeError):
    def __init__(self, status: str, message: str) -> None:
        if status not in _EXIT_CODES or status in {"dry_run", "evaluated"}:
            raise ValueError("coordinator failure status is invalid")
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class RunEvidence:
    status: str
    verdict: str | None
    manifest: dict[str, object]
    signature: str | None
    error: str | None = None
    run_dir: str | None = None
    cleanup_errors: tuple[str, ...] = ()

    @property
    def exit_code(self) -> int:
        if self.status == "evaluated" and self.verdict not in {"resolved", "unresolved"}:
            return 8
        return _EXIT_CODES.get(self.status, 8)


@dataclass
class _RunState:
    mode: str
    candidate_commit: str
    manifest: dict[str, object] = field(default_factory=dict)
    claim: object | None = None
    verdict: str | None = None
    run_dir: str | None = None


class CoordinatorServices(Protocol):
    def arm_cleanup(self, phase: str, state: _RunState): ...
    def authority(self, candidate_commit: str, state: _RunState) -> None: ...
    def candidate(self, candidate_commit: str, state: _RunState) -> None: ...
    def integrity_preflight(self, state: _RunState) -> None: ...
    def candidate_install(self, state: _RunState) -> None: ...
    def target_setup(self, state: _RunState) -> None: ...
    def attempt_claim(self, state: _RunState) -> None: ...
    def proxy_start(self, state: _RunState) -> None: ...
    def prepare_agent_launch(self, state: _RunState) -> None: ...
    def agent_start(self, state: _RunState) -> None: ...
    def agent_teardown(self, state: _RunState) -> None: ...
    def patch_capture(self, state: _RunState) -> None: ...
    def evaluation(self, state: _RunState) -> None: ...
    def evaluation_teardown(self, state: _RunState) -> None: ...
    def sign_results(self, state: _RunState) -> str: ...
    def cleanup(self, state: _RunState) -> None: ...
    def write_unsigned_failure(self, state: _RunState) -> None: ...


@dataclass(frozen=True)
class TrustedServiceConfig:
    repository: Path
    authority_commit: str
    host_config: HostConfig
    profile: BenchmarkProfile
    runtime: DockerRuntime
    fetcher: ArtifactFetcher
    evaluator: EvaluatorEnvironment
    proxy: ProxyNetwork
    signer: GateSigner
    public_key: Path
    state_dir: Path
    results_root: Path
    work_root: Path
    ollama_origin: str
    retry_claim: SignedClaim | None = None


class TrustedRunServices:
    """Concrete Task 1-8 composition used by the root-owned launcher."""

    def __init__(self, config: TrustedServiceConfig) -> None:
        self.config = config
        self.verified_candidate = None
        self.fetched: FetchedCandidate | None = None
        self.install: VerifiedCandidateInstall | None = None
        self.target: PreparedTarget | None = None
        self.endpoint: ProxyEndpoint | None = None
        self.agent: ContainerHandle | None = None
        self.agent_spec: ContainerSpec | None = None
        self.claim: SignedClaim | None = None
        self.instance: dict | None = None
        self.patch: bytes | None = None
        self.writer: ResultWriter | None = None
        self.agent_state_volume: str | None = None
        self.export_volume: str | None = None
        self.export_path: Path | None = None
        self.trusted_checkout: Path | None = None
        self.agent_absent = False
        self.agent_create_attempted = False
        self.agent_teardown_verified = False
        self.evaluator_absent = False
        self.evaluator_launch_attempted = False
        self.evaluation_result: EvaluationResult | None = None
        self.cleanup_completed = False
        self._run_id: str | None = None
        self._pending_signature: str | None = None

    @property
    def run_id(self) -> str:
        if self._run_id is None:
            raise RuntimeError("trusted run identity has not been created")
        return self._run_id

    def arm_cleanup(self, phase: str, state: _RunState):
        cleanups = {
            "candidate_install": lambda: self._cleanup_resource(
                "candidate_install", state, self._cleanup_install
            ),
            "target_setup": lambda: self._cleanup_resource(
                "target_setup", state, self._cleanup_target
            ),
            "proxy_start": lambda: self._cleanup_resource(
                "proxy", state, self.config.proxy.close
            ),
            "agent_start": lambda: self._cleanup_resource(
                "agent_resources", state, lambda: self._cleanup_agent(state)
            ),
            "patch_capture": lambda: self._cleanup_resource(
                "patch_resources", state, self._cleanup_patch_capture
            ),
            "evaluation": lambda: self._cleanup_resource(
                "evaluation_resources", state, lambda: None
            ),
        }
        cleanup = cleanups.get(phase)
        if cleanup is None:
            raise RuntimeError(f"no trusted cleanup is defined for resource phase {phase}")
        return cleanup

    def authority(self, candidate_commit: str, state: _RunState) -> None:
        config = self.config
        if config.authority_commit != config.host_config.authority_commit:
            raise RuntimeError("configured authority commit differs from the host trust anchor")
        expected_policies = {
            "apparmor": config.profile.security_policy.apparmor_sha256,
            "seccomp": config.profile.security_policy.seccomp_sha256,
        }
        if dict(config.host_config.confinement_policy_sha256) != expected_policies:
            raise RuntimeError("profile policies differ from the host trust anchor")
        try:
            public_key_digest = hashlib.sha256(config.public_key.read_bytes()).hexdigest()
        except OSError as error:
            raise RuntimeError("gate public key is unavailable") from error
        if public_key_digest != config.host_config.gate_public_key_sha256:
            raise RuntimeError("gate public key differs from the host trust anchor")
        observed_tree = coordinator_tree_digest(
            config.repository, config.authority_commit, COORDINATOR_PATHS
        )
        if observed_tree != config.host_config.coordinator_tree_sha256:
            raise RuntimeError("coordinator tree digest differs from the host trust anchor")
        policy = load_policy_from_commit(config.repository, config.authority_commit)
        self.verified_candidate = verify_candidate(
            config.repository, config.authority_commit, candidate_commit, policy
        )
        self._run_id = (
            f"alloy-{self.verified_candidate.version}-{candidate_commit[:12]}-{secrets.token_hex(6)}"
        )
        self.writer = ResultWriter(config.results_root, self.run_id)
        state.run_dir = str(self.writer.run_dir)
        state.manifest.update(
            schema_version=1,
            authority_commit=self.verified_candidate.authority_commit,
            coordinator_tree_sha256=observed_tree,
            host_config={
                "gate_public_key_sha256": config.host_config.gate_public_key_sha256,
                "confinement_policy_sha256": dict(
                    config.host_config.confinement_policy_sha256
                ),
            },
        )

    def candidate(self, candidate_commit: str, state: _RunState) -> None:
        if self.verified_candidate is None:
            raise RuntimeError("candidate verification did not complete")
        fetched = self.config.fetcher.fetch_candidate(self.verified_candidate)
        npm_cache = self.config.fetcher.fetch_npm_cache(fetched)
        bun = self.config.fetcher.fetch_bun()
        self.fetched = replace(fetched, npm_cache=npm_cache, bun_archive=bun)
        state.manifest.update(
            candidate_commit=candidate_commit,
            candidate_versions={
                "alloy": fetched.alloy_version,
                "pi": fetched.pi_version,
            },
            lock_digests={
                "bun": fetched.bun_lock_sha256,
                "evaluator": self.config.profile.evaluator.requirements_lock_sha256,
                "npm": fetched.lock_sha256,
            },
        )

    def integrity_preflight(self, state: _RunState) -> None:
        profile = self.config.profile
        try:
            self.instance = fetch_and_verify_instance(
                self.config.repository / "benchmarks/swebench/.cache/dataset", profile
            )
        except BaseException as error:
            raise CoordinatorFailure("dataset_failure", str(error)) from error
        self.target_source = self.config.fetcher.fetch_target_source(profile)
        self.config.evaluator.verify()
        report = self.config.runtime.preflight()
        image_ids = {
            "agent": self.config.runtime.verify_local_image(profile.agent_image),
            "evaluator": self.config.runtime.verify_local_image(profile.evaluator_image),
            "proxy": self.config.runtime.verify_local_image(profile.proxy_image),
        }
        model_digest = self._ollama_model_digest(profile.ollama_model)
        if model_digest != profile.model_digest:
            raise RuntimeError("Ollama model digest differs from the pinned profile")
        state.manifest.update(
            host_identity=asdict(report.daemon_identity),
            dataset={
                "name": profile.dataset.name,
                "parquet_sha256": profile.dataset.parquet_sha256,
                "revision": profile.dataset.revision,
                "row_sha256": profile.dataset.row_sha256,
            },
            image_digests={
                "agent": profile.agent_image.manifest_digest,
                "evaluator": profile.evaluator_image.manifest_digest,
                "proxy": profile.proxy_image.manifest_digest,
            },
            image_ids=image_ids,
            policy_digests={
                "apparmor": profile.security_policy.apparmor_sha256,
                "evaluator_patch": profile.evaluator.patch_sha256,
                "seccomp": profile.security_policy.seccomp_sha256,
            },
            model_digest=model_digest,
            preflight={
                "apparmor": report.apparmor,
                "cgroup_version": report.cgroup_version,
                "profile_fingerprint": report.profile_fingerprint,
                "seccomp": report.seccomp,
            },
        )

    def candidate_install(self, state: _RunState) -> None:
        if self.fetched is None:
            raise RuntimeError("candidate artifact verification did not complete")
        self.install = install_candidate(
            self.config.runtime,
            self.fetched,
            self.config.profile,
            run_id=self.run_id,
        )
        state.manifest["candidate_install"] = asdict(self.install)

    def target_setup(self, state: _RunState) -> None:
        if self.install is None:
            raise RuntimeError("candidate installation did not complete")
        self.target = prepare_target(
            self.config.runtime,
            self.target_source,
            self.config.profile,
            run_id=self.run_id,
        )
        self.agent_state_volume = f"alloy-agent-state-{self.run_id}"
        self.config.runtime.create_volume(self.agent_state_volume, self.run_id)
        self.config.runtime.initialize_volume(
            self.agent_state_volume,
            "/agent-state",
            self.run_id,
            self.config.profile.agent_image,
            self.install.image_id,
        )
        state.manifest["target_setup"] = asdict(self.target)

    def _attempt_key(self) -> AttemptKey:
        profile = self.config.profile
        profile_value = json.loads(json.dumps(asdict(profile)))
        authority_profile_digest = hashlib.sha256(
            canonical_json_bytes(
                {
                    "authority_commit": self.config.authority_commit,
                    "profile": profile_value,
                }
            )
        ).hexdigest()
        if self.verified_candidate is None:
            raise RuntimeError("candidate verification did not complete")
        return AttemptKey(
            self.verified_candidate.candidate_commit,
            profile.instance_id,
            profile.dataset.revision,
            profile.dataset.row_sha256,
            profile.model_digest,
            authority_profile_digest,
        )

    def attempt_claim(self, state: _RunState) -> None:
        key = self._attempt_key()
        claim = self.config.retry_claim
        if claim is None:
            claim = claim_first_attempt(self.config.state_dir, key, self.config.signer)
        verify_claim(claim, self.config.public_key, key)
        self.claim = claim
        state.claim = claim
        state.manifest["attempt_ordinal"] = claim.ordinal
        state.manifest["attempt_claim"] = claim.as_dict()

    def proxy_start(self, state: _RunState) -> None:
        self.endpoint = self.config.proxy.start(self.run_id)
        state.manifest.setdefault("container_ids", {})["proxy"] = (
            self.endpoint.container.container_id
        )
        state.manifest.setdefault("container_inspections", {})["proxy"] = (
            self.endpoint.inspection
        )

    def prepare_agent_launch(self, state: _RunState) -> None:
        if self.claim is None:
            raise RuntimeError("verified attempt claim is missing before agent launch")
        self.agent_spec = self._build_agent_spec()

    def agent_start(self, state: _RunState) -> None:
        if self.agent_spec is None or self.endpoint is None:
            raise RuntimeError("agent launch specification is unavailable")
        runtime = self.config.runtime
        profile = self.config.profile
        pending = ContainerHandle(
            self.agent_spec.name, self.agent_spec.name, self.agent_spec.run_id
        )

        def consume_at_create_boundary() -> None:
            if self.claim is None:
                raise RuntimeError("verified attempt claim is missing at agent launch")
            consume_claim(
                self.config.state_dir,
                self.claim,
                self.config.public_key,
                self._attempt_key(),
            )
            self.agent_create_attempted = True

        try:
            self.agent = runtime.create(
                self.agent_spec, before_create=consume_at_create_boundary
            )
        except CleanupUncertainError as error:
            self.agent = error.handle
            state.manifest.setdefault("container_inspections", {})["agent"] = {
                "cleanup_uncertain": True,
                "container_id": error.handle.container_id,
            }
            raise
        except BaseException:
            if self.agent_create_attempted:
                self.agent = pending
            raise
        state.manifest.setdefault("container_ids", {})["agent"] = self.agent.container_id
        self.config.proxy._docker("network", "disconnect", "none", self.agent.container_id)
        self.config.proxy._docker(
            "network", "connect", self.endpoint.network, self.agent.container_id
        )
        state.manifest.setdefault("container_inspections", {})["agent"] = (
            runtime.inspect_security(
                self.agent,
                self.agent_spec,
                expected_networks=(self.endpoint.network,),
            )
        )
        try:
            status = runtime.wait(self.agent, timeout=profile.agent_timeout_seconds)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("agent exceeded the pinned timeout") from error
        if status != 0:
            raise RuntimeError(f"agent exited with status {status}")

    def agent_teardown(self, state: _RunState) -> None:
        if not self.agent_create_attempted:
            state.manifest.setdefault("teardown", {})["agent_launch_attempted"] = False
            return
        if self.agent is None:
            raise RuntimeError("agent create was attempted without a cleanup handle")
        handle = self.agent
        self.config.runtime.force_remove(handle)
        self.config.runtime.assert_absent(handle)
        self.agent = None
        self.agent_teardown_verified = True
        self.agent_absent = True
        state.manifest.setdefault("container_inspections", {}).setdefault("agent", {})[
            "absent"
        ] = True
        state.manifest.setdefault("teardown", {})["agent_absent"] = True

    def patch_capture(self, state: _RunState) -> None:
        if not self.agent_absent or self.target is None:
            raise RuntimeError("trusted patch capture requires proven agent absence")
        runtime = self.config.runtime
        profile = self.config.profile
        self.export_volume = f"alloy-export-{self.run_id}"
        runtime.create_volume(self.export_volume, self.run_id)
        runtime.initialize_volume(
            self.export_volume,
            "/export",
            self.run_id,
            profile.evaluator_image,
            self.target.image_id,
        )
        script = (
            "cd /agent-work; "
            "find . -mindepth 1 -maxdepth 1 ! -name .git -printf '%P\\0' | sort -z | "
            "tar --null --exclude=.git --exclude='*/.git' -cf /export/agent.tar -T -"
        )
        spec = ContainerSpec(
            name=f"alloy-export-{self.run_id}",
            run_id=self.run_id,
            image=profile.evaluator_image,
            image_id=self.target.image_id,
            command=("/bin/bash", "-euc", script),
            mounts=(
                MountSpec(self.target.agent_volume, "/agent-work", True, "volume"),
                MountSpec(self.export_volume, "/export", False, "volume"),
            ),
        )
        helper = runtime.create(spec)
        try:
            if runtime.wait(helper, timeout=profile.evaluator_timeout_seconds) != 0:
                raise RuntimeError("confined agent export failed")
            scratch = self._scratch()
            self.export_path = scratch / "agent.tar"
            runtime._run(
                runtime._docker_arguments(
                    "cp", f"{helper.container_id}:/export/agent.tar", str(self.export_path)
                )
            )
        finally:
            runtime.force_remove(helper)
        bounds = ExportBounds(
            profile.limits.max_files,
            profile.limits.max_file_bytes,
            profile.limits.max_export_bytes,
        )
        with validate_exported_tar(self.export_path, bounds) as exported:
            base = self.config.fetcher.target_repository
            if base is None:
                raise RuntimeError("trusted target Git repository is unavailable")
            self.trusted_checkout = self._scratch() / "trusted-checkout"
            reconstruct_trusted_checkout(base, exported, self.trusted_checkout)
        self.patch = capture_patch(self.trusted_checkout)
        digest = hashlib.sha256(self.patch).hexdigest()
        state.manifest["patch_sha256"] = digest
        if self.writer is None:
            raise RuntimeError("trusted result writer is unavailable")
        self.writer.write_text("model_patch.diff", self.patch.decode("utf-8"))

    def evaluation(self, state: _RunState) -> None:
        if not self.agent_absent or self.patch is None or self.instance is None:
            raise RuntimeError("evaluation requires agent absence and a trusted patch")
        scratch = Path(tempfile.mkdtemp(prefix="evaluation-", dir=self._scratch()))
        predictions = scratch / "predictions.jsonl"
        prediction = {
            "instance_id": self.config.profile.instance_id,
            "model_name_or_path": (
                f"alloy-{self.install.alloy_version}/{self.config.profile.model}"
            ),
            "model_patch": self.patch.decode("utf-8"),
        }
        predictions.write_bytes(canonical_json_bytes(prediction) + b"\n")
        dataset = scratch / "dataset.json"
        write_private_dataset_json(dataset, self.instance)
        try:
            self.evaluator_launch_attempted = True
            result = self.config.evaluator.run(predictions, dataset, self.run_id)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("official evaluator exceeded the pinned timeout") from error
        self.evaluation_result = result
        container_id = result.container_evidence.get("container_id")
        if not isinstance(container_id, str) or not container_id:
            raise RuntimeError("evaluator returned no observed container identity")
        if result.teardown_evidence.get("absent") is not True:
            raise RuntimeError("evaluator returned no verified teardown proof")
        state.manifest.setdefault("container_ids", {})["evaluator"] = container_id
        state.manifest.setdefault("container_inspections", {})["evaluator"] = (
            result.container_evidence
        )
        state.manifest.setdefault("teardown", {})["evaluator"] = (
            result.teardown_evidence
        )
        verdict = self._official_verdict(result.summary)
        summary_bytes = canonical_json_bytes(result.summary)
        state.verdict = verdict
        state.manifest["evaluator_summary_sha256"] = hashlib.sha256(
            summary_bytes
        ).hexdigest()
        if self.writer is None:
            raise RuntimeError("trusted result writer is unavailable")
        self.writer.write_json("official-summary.json", result.summary)
        self.writer.write_text("evaluator.stderr.log", result.stderr)
        self.writer.write_text("evaluator.stdout.log", result.stdout)
        self.writer.write_text("predictions.jsonl", predictions.read_text())

    def evaluation_teardown(self, state: _RunState) -> None:
        if self.evaluation_result is None:
            proof = self.config.evaluator._last_teardown_evidence
            if proof is None:
                proof = self.config.evaluator._verify_and_teardown_container(self.run_id)
            if proof.get("absent") is not True:
                raise RuntimeError("evaluator teardown could not prove absence")
            state.manifest.setdefault("teardown", {})["evaluator"] = proof
        elif self.evaluation_result.teardown_evidence.get("absent") is not True:
            raise RuntimeError("evaluator teardown could not prove absence")
        self.evaluator_absent = True
        state.manifest.setdefault("teardown", {})["evaluator_absent"] = True

    def sign_results(self, state: _RunState) -> str:
        if self.writer is None:
            raise RuntimeError("trusted result writer is unavailable")
        if (
            not self.cleanup_completed
            or state.manifest.get("cleanup_proven") is not True
            or state.manifest.get("cleanup_errors")
        ):
            raise RuntimeError("terminal evidence cannot be signed before clean teardown")
        agent_safe = self.agent_absent or not self.agent_create_attempted
        evaluator_safe = self.evaluator_absent or not self.evaluator_launch_attempted
        if state.mode == "release" and not (agent_safe and evaluator_safe):
            raise RuntimeError("release evidence requires proven agent and evaluator absence")
        content = canonical_json_bytes(state.manifest)
        signature = base64.b64encode(self.config.signer.sign(content)).decode("ascii")
        self.writer.write_json("manifest.json", state.manifest)
        self.writer.write_json(
            "manifest.signature.json",
            {"algorithm": "Ed25519", "signature": signature},
        )
        self._pending_signature = signature
        self._close_writer()
        return signature

    def write_unsigned_failure(self, state: _RunState) -> None:
        if self.writer is None:
            run_name = (
                f"failed-{state.candidate_commit[:12]}-{secrets.token_hex(6)}"
            )
            self.writer = ResultWriter(self.config.results_root, run_name)
            state.run_dir = str(self.writer.run_dir)
        try:
            self.writer.write_json(
                "failure.json",
                {"evidence": state.manifest, "signed": False},
            )
        except BaseException:
            self._close_writer()
            run_name = (
                f"failed-{state.candidate_commit[:12]}-{secrets.token_hex(6)}"
            )
            self.writer = ResultWriter(self.config.results_root, run_name)
            state.run_dir = str(self.writer.run_dir)
            self.writer.write_json(
                "failure.json",
                {"evidence": state.manifest, "signed": False},
            )
        self._close_writer()

    def cleanup(self, state: _RunState) -> None:
        scratch = getattr(self, "_scratch_dir", None)
        if scratch is not None:
            shutil.rmtree(scratch)
            self._scratch_dir = None
        self.cleanup_completed = True

    def _close_writer(self) -> None:
        if self.writer is not None:
            writer = self.writer
            self.writer = None
            try:
                writer.close()
            except BaseException:
                # Each artifact and directory entry is already fsynced. A close error
                # cannot turn a fully persisted manifest/signature pair into failure.
                pass

    @property
    def final_signature(self) -> str | None:
        return self._pending_signature

    @staticmethod
    def _cleanup_resource(name: str, state: _RunState, cleanup) -> None:
        cleanup()
        state.manifest.setdefault("teardown", {})[name] = True

    def _cleanup_install(self) -> None:
        if self.install is not None:
            self.config.runtime.remove_volume(self.install.app_volume, self.run_id)
            self.install = None

    def _cleanup_target(self) -> None:
        if self.target is not None:
            self.config.runtime.remove_volume(self.target.agent_volume, self.run_id)
            self.target = None
        if self.agent_state_volume is not None:
            self.config.runtime.remove_volume(self.agent_state_volume, self.run_id)
            self.agent_state_volume = None

    def _cleanup_agent(self, state: _RunState) -> None:
        if not self.agent_create_attempted or self.agent_teardown_verified:
            return
        if self.agent is None:
            raise RuntimeError("agent create was attempted without a cleanup handle")
        handle = self.agent
        self.config.runtime.force_remove(handle)
        self.config.runtime.assert_absent(handle)
        self.agent = None
        self.agent_teardown_verified = True
        self.agent_absent = True
        state.manifest.setdefault("container_inspections", {}).setdefault("agent", {})[
            "absent"
        ] = True
        state.manifest.setdefault("teardown", {})["agent_absent"] = True

    def _cleanup_patch_capture(self) -> None:
        if self.export_volume is not None:
            self.config.runtime.remove_volume(self.export_volume, self.run_id)
            self.export_volume = None
        if self.trusted_checkout is not None:
            shutil.rmtree(self.trusted_checkout, ignore_errors=True)
            self.trusted_checkout = None

    def _scratch(self) -> Path:
        scratch = getattr(self, "_scratch_dir", None)
        if scratch is None:
            self.config.work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            scratch = Path(
                tempfile.mkdtemp(prefix=f"{self.run_id}-", dir=self.config.work_root)
            )
            self._scratch_dir = scratch
        return scratch

    def _prompt(self) -> str:
        if self.instance is None:
            raise RuntimeError("verified dataset instance is unavailable")
        public = prompt_instance(self.instance)
        return (
            "You are solving one software issue in an isolated repository checkout.\n\n"
            f"Issue:\n{public['problem_statement']}\n\n"
            "Inspect the repository, identify the root cause, implement the smallest "
            "correct fix, and run relevant tests. Leave intended changes in the working tree."
        )

    def _build_agent_spec(self) -> ContainerSpec:
        if (
            self.install is None
            or self.target is None
            or self.endpoint is None
            or self.agent_state_volume is None
        ):
            raise RuntimeError("agent prerequisites are incomplete")
        profile = self.config.profile
        command = (
            "/bin/bash",
            "-euc",
            (
                "cd /agent-work; "
                "until (: >/dev/tcp/$PROXY_HOST/$PROXY_PORT) 2>/dev/null; do sleep 0.05; done; "
                "exec /opt/alloy/prefix/bin/alloy --model \"$MODEL\" -p \"$PROMPT\""
            ),
        )
        return ContainerSpec(
            name=f"alloy-agent-{self.run_id}",
            run_id=self.run_id,
            image=profile.agent_image,
            image_id=self.install.image_id,
            command=command,
            mounts=(
                self.install.app_mount(),
                MountSpec(self.target.agent_volume, "/agent-work", False, "volume"),
                MountSpec(self.agent_state_volume, "/agent-state", False, "volume"),
            ),
            environment=(
                ("HOME", "/agent-state/home"),
                ("MODEL", profile.model),
                ("OLLAMA_HOST", self.endpoint.url),
                ("PROMPT", self._prompt()),
                ("PROXY_HOST", self.endpoint.host),
                ("PROXY_PORT", str(self.endpoint.port)),
            ),
        )

    def _ollama_model_digest(self, model: str) -> str:
        endpoint = self.config.ollama_origin.rstrip("/") + "/api/tags"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(endpoint, timeout=10) as response:
                value = json.load(response)
        except (OSError, ValueError) as error:
            raise RuntimeError("could not read the local Ollama model inventory") from error
        models = value.get("models") if isinstance(value, dict) else None
        if not isinstance(models, list):
            raise RuntimeError("Ollama returned an invalid local model inventory")
        for item in models:
            if isinstance(item, dict) and item.get("name") == model:
                digest = item.get("digest")
                if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest):
                    return digest
        raise RuntimeError(f"Ollama model {model} is unavailable or has an invalid digest")

    def _official_verdict(self, summary: object) -> str:
        if not isinstance(summary, dict) or summary.get("schema_version") != 2:
            raise CoordinatorFailure("evaluator_failure", "unsupported evaluator summary")
        instance = self.config.profile.instance_id
        categories = {
            name: summary.get(name, [])
            for name in (
                "infra_failure_ids",
                "ambiguous_failure_ids",
                "error_ids",
                "resolved_ids",
                "unresolved_ids",
                "empty_patch_ids",
            )
        }
        if any(
            not isinstance(values, list)
            or any(not isinstance(value, str) for value in values)
            for values in categories.values()
        ):
            raise CoordinatorFailure("evaluator_failure", "malformed evaluator categories")
        if any(instance in categories[name] for name in (
            "infra_failure_ids", "ambiguous_failure_ids", "error_ids"
        )):
            raise CoordinatorFailure("evaluator_failure", "official evaluator reported failure")
        resolved = instance in categories["resolved_ids"]
        unresolved = instance in categories["unresolved_ids"] or instance in categories[
            "empty_patch_ids"
        ]
        if resolved == unresolved:
            raise CoordinatorFailure("evaluator_failure", "official evaluator verdict is ambiguous")
        return "resolved" if resolved else "unresolved"

    @staticmethod
    def _container_spec(spec: ContainerSpec) -> dict[str, object]:
        return {
            "image_id": spec.image_id,
            "mounts": [
                {
                    "kind": mount.kind,
                    "read_only": mount.read_only,
                    "target": mount.target,
                }
                for mount in spec.mounts
            ],
            "network_mode": spec.network_mode,
            "privileged": spec.privileged,
        }


class TrustedCoordinator:
    def __init__(self, services: CoordinatorServices) -> None:
        self.services = services

    def dry_run(self, candidate_commit: str) -> RunEvidence:
        return self._run("dry_run", candidate_commit)

    def release(self, candidate_commit: str) -> RunEvidence:
        return self._run("release", candidate_commit)

    def _run(self, mode: str, candidate_commit: str) -> RunEvidence:
        if not isinstance(candidate_commit, str) or _GIT_SHA.fullmatch(candidate_commit) is None:
            raise ValueError("candidate commit must be a full lowercase Git SHA")
        state = _RunState(mode, candidate_commit)
        if mode == "release":
            state.manifest.update(
                attempt_ordinal=None,
                container_ids={},
                container_inspections={},
                evaluator_summary_sha256=None,
                patch_sha256=None,
                teardown={},
            )
        cleanups = []
        current_phase = "authority"
        success_status = "dry_run" if mode == "dry_run" else "evaluated"
        status = success_status
        primary_error: BaseException | None = None
        primary_phase: str | None = None
        cleanup_errors: list[tuple[str, BaseException]] = []
        signature: str | None = None

        def phase(name: str, operation, *, resource: bool = False) -> None:
            nonlocal current_phase
            current_phase = name
            if resource:
                cleanups.append((name, self.services.arm_cleanup(name, state)))
            operation()

        def record_cleanup(phase_name: str, caught: BaseException) -> None:
            cleanup_errors.extend(
                (phase_name, failure)
                for failure in flatten_cleanup_failures(caught)
            )

        def primary_cause(
            caught: BaseException, cleanup_phase: str
        ) -> BaseException:
            classified = classify_cleanup_uncertainty(caught)
            if classified is not None:
                original_error, failures = classified
                cleanup_errors.extend(
                    (cleanup_phase, failure) for failure in failures
                )
                return original_error
            return caught

        try:
            phase("authority", lambda: self.services.authority(candidate_commit, state))
            phase("candidate", lambda: self.services.candidate(candidate_commit, state))
            phase("integrity_preflight", lambda: self.services.integrity_preflight(state))
            phase(
                "candidate_install",
                lambda: self.services.candidate_install(state),
                resource=True,
            )
            if mode == "release":
                phase("target_setup", lambda: self.services.target_setup(state), resource=True)
                phase("attempt_claim", lambda: self.services.attempt_claim(state))
                phase("proxy_start", lambda: self.services.proxy_start(state), resource=True)
                current_phase = "agent_start"
                cleanups.append(
                    ("agent_start", self.services.arm_cleanup("agent_start", state))
                )
                self.services.prepare_agent_launch(state)
                try:
                    self.services.agent_start(state)
                except BaseException as caught:
                    primary_error = primary_cause(caught, "agent_start_cleanup")
                    primary_phase = "agent_start"
                try:
                    phase("agent_teardown", lambda: self.services.agent_teardown(state))
                except BaseException as caught:
                    record_cleanup("agent_teardown", caught)
                if primary_error is not None:
                    raise primary_error
                if cleanup_errors:
                    primary_phase = "agent_teardown"
                    raise CoordinatorFailure(
                        "agent_failure", "agent teardown could not prove absence"
                    )
                phase(
                    "patch_capture",
                    lambda: self.services.patch_capture(state),
                    resource=True,
                )
                evaluation_error: BaseException | None = None
                try:
                    phase("evaluation", lambda: self.services.evaluation(state), resource=True)
                except BaseException as caught:
                    evaluation_error = primary_cause(caught, "evaluation_teardown")
                    primary_phase = "evaluation"
                try:
                    phase(
                        "evaluation_teardown",
                        lambda: self.services.evaluation_teardown(state),
                    )
                except BaseException as caught:
                    record_cleanup("evaluation_teardown", caught)
                if evaluation_error is not None:
                    primary_error = evaluation_error
                    raise evaluation_error
                if state.verdict not in {"resolved", "unresolved"}:
                    raise CoordinatorFailure(
                        "evaluator_failure", "official evaluator produced no valid verdict"
                    )
        except BaseException as caught:
            if primary_error is None:
                primary_error = primary_cause(
                    caught, f"{current_phase}_cleanup"
                )
                primary_phase = current_phase
            elif caught is not primary_error:
                record_cleanup(f"{current_phase}_cleanup", caught)

        if primary_error is not None:
            if isinstance(primary_error, CoordinatorFailure):
                status = primary_error.status
            elif isinstance(primary_error, (TimeoutError, subprocess.TimeoutExpired)) and primary_phase == "agent_start":
                status = "agent_timeout"
            elif isinstance(primary_error, (TimeoutError, subprocess.TimeoutExpired)) and primary_phase == "evaluation":
                status = "evaluator_timeout"
            else:
                status = _FAILURE_STATUS.get(primary_phase or "", "runtime_failure")

        for cleanup_phase, cleanup in reversed(cleanups):
            try:
                cleanup()
            except BaseException as caught:
                record_cleanup(cleanup_phase, caught)
        try:
            current_phase = "cleanup"
            self.services.cleanup(state)
        except BaseException as caught:
            record_cleanup("cleanup", caught)

        if cleanup_errors and primary_error is None:
            status = "runtime_failure"
        state.manifest["terminal_status"] = status
        state.manifest["verdict"] = state.verdict
        state.manifest["cleanup_proven"] = not cleanup_errors
        if primary_error is not None:
            state.manifest["primary_error"] = str(primary_error)
        state.manifest["cleanup_errors"] = [
            {"phase": phase_name, "error": str(caught)}
            for phase_name, caught in cleanup_errors
        ]

        if cleanup_errors:
            self.services.write_unsigned_failure(state)
        else:
            try:
                current_phase = "sign_results"
                signature = self.services.sign_results(state)
            except BaseException as caught:
                primary_error = primary_error or caught
                if primary_error is caught:
                    status = "runtime_failure"
                record_cleanup("sign_results", caught)
                state.manifest["terminal_status"] = status
                state.manifest["primary_error"] = str(primary_error)
                state.manifest["cleanup_proven"] = False
                state.manifest["cleanup_errors"] = [
                    {"phase": phase_name, "error": str(error)}
                    for phase_name, error in cleanup_errors
                ]
                signature = None
                self.services.write_unsigned_failure(state)

        manifest = copy.deepcopy(state.manifest)
        return RunEvidence(
            status,
            state.verdict,
            manifest,
            signature,
            str(primary_error) if primary_error is not None else None,
            state.run_dir,
            tuple(
                f"{phase_name}: {caught}" for phase_name, caught in cleanup_errors
            ),
        )


if __name__ == "__main__":
    raise SystemExit(
        "error: direct coordinator execution is forbidden; use the trusted host launcher"
    )
