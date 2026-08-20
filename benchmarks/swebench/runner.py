from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from benchmarks.swebench.profile import BenchmarkProfile, load_profile, parse_profile

try:
    from datasets import load_dataset
except ImportError:
    load_dataset = None

PRIVATE_FIELDS = {"patch", "test_patch"}
BENCH_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BENCH_ROOT.parents[1]
PROFILE_PATH = BENCH_ROOT / "profile.json"
FULL_GIT_SHA = re.compile(r"[0-9a-f]{40}")
SEMANTIC_VERSION = re.compile(
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


@dataclass(frozen=True)
class CandidateMetadata:
    alloy_version: str
    pi_version: str
    commit: str
    root: Path


def _read_json_object(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is missing or invalid") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be a JSON object")
    return value


def load_candidate_metadata(
    candidate_root: Path, candidate_commit: str
) -> CandidateMetadata:
    if not isinstance(candidate_commit, str) or FULL_GIT_SHA.fullmatch(candidate_commit) is None:
        raise RuntimeError("candidate must specify a full candidate commit as a lowercase Git SHA")
    root = candidate_root.resolve()
    package = _read_json_object(root / "package.json", "candidate package.json")
    alloy_version = package.get("version")
    if not isinstance(alloy_version, str) or SEMANTIC_VERSION.fullmatch(alloy_version) is None:
        raise RuntimeError("candidate Alloy version must be semantic")
    alloy = package.get("alloy")
    pi_fork = alloy.get("piFork") if isinstance(alloy, dict) else None
    pi_version = pi_fork.get("version") if isinstance(pi_fork, dict) else None
    if not isinstance(pi_version, str) or SEMANTIC_VERSION.fullmatch(pi_version) is None:
        raise RuntimeError("candidate Pi version must be semantic")
    return CandidateMetadata(alloy_version, pi_version, candidate_commit, root)


def load_install_manifest(path: Path) -> dict[str, str]:
    manifest = _read_json_object(path, "install manifest")
    allowed = {"channel", "commit", "installedAt", "ref", "repository", "version"}
    unknown = set(manifest) - allowed
    if unknown:
        raise RuntimeError(f"unknown install manifest keys: {sorted(map(str, unknown))}")
    missing = {"commit", "version"} - set(manifest)
    if missing:
        raise RuntimeError(f"missing install manifest keys: {sorted(missing)}")
    for key in (allowed & set(manifest)) - {"commit", "version", "ref"}:
        if not isinstance(manifest[key], str):
            raise RuntimeError(f"install manifest {key} must be a string")
    if "ref" in manifest and manifest["ref"] is not None and not isinstance(
        manifest["ref"], str
    ):
        raise RuntimeError("install manifest ref must be a string or null")
    commit = manifest["commit"]
    version = manifest["version"]
    if not isinstance(commit, str) or FULL_GIT_SHA.fullmatch(commit) is None:
        raise RuntimeError("install manifest commit must be a full lowercase Git SHA")
    if not isinstance(version, str) or SEMANTIC_VERSION.fullmatch(version) is None:
        raise RuntimeError("install manifest version must be semantic")
    return {"commit": commit, "version": version}


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    returncode: int


class CommandError(RuntimeError):
    def __init__(self, command: list[str], stdout: str, stderr: str, message: str) -> None:
        super().__init__(message)
        self.command = tuple(command)
        self.stdout = stdout
        self.stderr = stderr


class CommandFailed(CommandError):
    def __init__(
        self, command: list[str], stdout: str, stderr: str, returncode: int
    ) -> None:
        self.returncode = returncode
        super().__init__(command, stdout, stderr, f"command exit {returncode}: {command[0]}")


class CommandTimedOut(CommandError):
    def __init__(self, command: list[str], stdout: str, stderr: str, timeout: float) -> None:
        self.timeout = timeout
        super().__init__(command, stdout, stderr, f"command timed out after {timeout}s: {command[0]}")


def _run_command(
    command: list[str],
    cwd: Path,
    timeout: float,
    accepted_returncodes: frozenset[int],
    *,
    env: dict[str, str] | None = None,
) -> CommandResult:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env=env,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        raise CommandTimedOut(command, stdout, stderr, timeout) from error
    if process.returncode not in accepted_returncodes:
        raise CommandFailed(command, stdout, stderr, process.returncode)
    return CommandResult(stdout, stderr, process.returncode)


def run_command(
    command: list[str], cwd: Path, timeout: float, *, env: dict[str, str] | None = None
) -> CommandResult:
    return _run_command(command, cwd, timeout, frozenset({0}), env=env)


def checkout_instance(repo: str, base_commit: str, destination: Path) -> None:
    run_command(
        ["git", "clone", "--filter=blob:none", f"https://github.com/{repo}.git", str(destination)],
        Path.cwd(),
        900,
    )
    run_command(["git", "checkout", "--detach", base_commit], destination, 120)
    run_command(["git", "reset", "--hard", base_commit], destination, 120)
    run_command(["git", "clean", "-ffdqx"], destination, 120)


def alloy_command(alloy_bin: Path, model: str, prompt: str) -> list[str]:
    return [str(alloy_bin), "--model", model, "-p", prompt]


def run_alloy(
    alloy_bin: Path,
    profile: BenchmarkProfile,
    checkout: Path,
    prompt: str,
    environment: dict[str, str],
) -> CommandResult:
    return run_command(
        alloy_command(alloy_bin, profile.model, prompt),
        checkout,
        profile.agent_timeout_seconds,
        env=environment,
    )


def capture_patch(checkout: Path) -> str:
    patch = run_command(
        ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"], checkout, 120
    ).stdout
    untracked = run_command(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"], checkout, 120
    ).stdout
    for path in filter(None, untracked.split("\0")):
        patch += _run_command(
            ["git", "diff", "--binary", "--no-ext-diff", "--no-index", "--", "/dev/null", path],
            checkout,
            120,
            frozenset({0, 1}),
        ).stdout
    return patch


def public_instance(row: dict) -> dict:
    return {key: value for key, value in row.items() if key not in PRIVATE_FIELDS}


def build_prompt(instance: dict) -> str:
    return f"""You are solving one software issue in an isolated repository checkout.

Issue:
{instance['problem_statement']}

Inspect the repository, identify the root cause, implement the smallest correct fix,
and run relevant tests. Do not merely describe a patch. Leave all intended changes in
the working tree for evaluation. Do not create commits or access external benchmark
answers.
"""


def prediction_record(instance_id: str, model: str, patch: str) -> dict:
    return {
        "instance_id": instance_id,
        "model_name_or_path": model,
        "model_patch": patch,
    }


def load_instance(profile: BenchmarkProfile) -> dict:
    if load_dataset is None:
        raise RuntimeError("install requirements-swebench.txt in .venv first")
    rows = load_dataset(profile.dataset.name, split=profile.split)
    matches = [row for row in rows if row["instance_id"] == profile.instance_id]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected one dataset row for {profile.instance_id}, found {len(matches)}"
        )
    row = matches[0]
    if row["base_commit"] != profile.base_commit:
        raise RuntimeError(f"dataset base commit drift for {profile.instance_id}")
    return public_instance(dict(row))


def write_prediction_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def evaluator_command(
    profile: BenchmarkProfile, python: Path, predictions: Path, run_id: str
) -> list[str]:
    return [
        str(python),
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        profile.dataset.name,
        "--split",
        profile.split,
        "--instance_ids",
        profile.instance_id,
        "--predictions_path",
        str(predictions),
        "--max_workers",
        "1",
        "--timeout",
        str(profile.agent_timeout_seconds),
        "--run_id",
        run_id,
    ]


def agent_environment(
    state_root: Path, parent_environment: dict[str, str] | None = None
) -> dict[str, str]:
    parent = os.environ if parent_environment is None else parent_environment
    environment = {
        key: parent[key]
        for key in ("PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR")
        if key in parent
    }
    environment.setdefault("PATH", os.defpath)
    environment["OLLAMA_HOST"] = _local_ollama_host(
        parent.get("OLLAMA_HOST", "http://127.0.0.1:11434")
    )
    directories = {
        "HOME": state_root / "home",
        "XDG_CONFIG_HOME": state_root / "xdg-config",
        "XDG_CACHE_HOME": state_root / "xdg-cache",
        "XDG_DATA_HOME": state_root / "xdg-data",
        "XDG_STATE_HOME": state_root / "xdg-state",
        "TMPDIR": state_root / "tmp",
    }
    for key, path in directories.items():
        path.mkdir(parents=True, exist_ok=True)
        environment[key] = str(path)
    return environment


def _local_ollama_host(value: str) -> str:
    parsed = urllib.parse.urlparse(value if "://" in value else f"http://{value}")
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("OLLAMA_HOST must route to a local Ollama service")
    return value


def probe_runtime_versions(alloy_bin: Path, environment: dict[str, str]) -> dict[str, str]:
    result = run_command(
        [str(alloy_bin), "--version"], REPO_ROOT, 30, env=environment
    )
    alloy = re.search(r"^Alloy\s+(\S+)\s*$", result.stdout, re.MULTILINE)
    pi = re.search(r"^Pi\s+(\S+)\s*$", result.stdout, re.MULTILINE)
    if alloy is None or pi is None:
        raise RuntimeError("could not parse Alloy and Pi versions from alloy --version")
    return {"alloy_version": alloy.group(1), "pi_version": pi.group(1)}


def probe_swebench_version(python: Path, environment: dict[str, str]) -> str:
    command = [
        str(python),
        "-c",
        "import importlib.metadata; print(importlib.metadata.version('swebench'))",
    ]
    return run_command(command, REPO_ROOT, 30, env=environment).stdout.strip()


def model_digest_from_tags(profile: BenchmarkProfile, tags: object) -> str:
    if not isinstance(tags, dict) or not isinstance(tags.get("models"), list):
        raise RuntimeError("Ollama returned an invalid local model inventory")
    for model in tags["models"]:
        if isinstance(model, dict) and model.get("name") == profile.ollama_model:
            digest = model.get("digest")
            if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest):
                return digest
            raise RuntimeError(f"Ollama model {profile.ollama_model} has an invalid digest")
    raise RuntimeError(f"Ollama model {profile.ollama_model} is not installed")


def probe_ollama_model_digest(
    profile: BenchmarkProfile, environment: dict[str, str]
) -> str:
    host = _local_ollama_host(environment["OLLAMA_HOST"])
    base_url = host if "://" in host else f"http://{host}"
    endpoint = f"{base_url.rstrip('/')}/api/tags"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(endpoint, timeout=10) as response:
            tags = json.load(response)
    except (OSError, ValueError) as error:
        raise RuntimeError("could not read the local Ollama model inventory") from error
    return model_digest_from_tags(profile, tags)


def probe_live_provenance(
    alloy_bin: Path,
    profile: BenchmarkProfile,
    python: Path,
    environment: dict[str, str],
) -> dict[str, str]:
    return {
        **probe_runtime_versions(alloy_bin, environment),
        "model_digest": probe_ollama_model_digest(profile, environment),
        "swebench_version": probe_swebench_version(python, environment),
    }


def official_verdict(profile: BenchmarkProfile, evaluation_dir: Path) -> str:
    path = evaluation_dir / "official-summary.json"
    try:
        report = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("official evaluator summary is missing or invalid") from error
    if not isinstance(report, dict) or report.get("schema_version") != 2:
        raise RuntimeError("official evaluator produced an unsupported summary schema")
    categories = (
        "infra_failure_ids",
        "ambiguous_failure_ids",
        "error_ids",
        "resolved_ids",
        "unresolved_ids",
        "empty_patch_ids",
    )
    classified: dict[str, list[str]] = {}
    for category in categories:
        values = report.get(category, [])
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise RuntimeError(f"official evaluator category {category} must be a list of strings")
        classified[category] = values
    for category in ("infra_failure_ids", "ambiguous_failure_ids", "error_ids"):
        if profile.instance_id in classified[category]:
            raise RuntimeError(
                f"official evaluator classified {profile.instance_id} in {category}"
            )
    resolved = profile.instance_id in classified["resolved_ids"]
    unresolved = profile.instance_id in classified["unresolved_ids"] or profile.instance_id in classified[
        "empty_patch_ids"
    ]
    if resolved and unresolved:
        raise RuntimeError(
            f"official evaluator produced contradictory verdicts for {profile.instance_id}"
        )
    if resolved:
        return "resolved"
    if unresolved:
        return "unresolved"
    raise RuntimeError(f"official evaluator produced no verdict for {profile.instance_id}")


def run_official_evaluation(
    profile: BenchmarkProfile,
    python: Path,
    predictions: Path,
    run_id: str,
    work_root: Path,
    evaluation_dir: Path,
) -> str:
    work_root.mkdir(parents=True, exist_ok=True)
    evaluation_dir.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix=f"{run_id}-evaluator-", dir=work_root) as directory:
        scratch = Path(directory)
        try:
            evaluation = run_command(
                evaluator_command(profile, python, predictions.resolve(), run_id),
                scratch,
                profile.evaluator_timeout_seconds,
            )
        except CommandError as error:
            write_command_logs(
                evaluation_dir / "stdout.log", evaluation_dir / "stderr.log", error
            )
            raise
        (evaluation_dir / "stdout.log").write_text(evaluation.stdout)
        (evaluation_dir / "stderr.log").write_text(evaluation.stderr)
        summaries = list(scratch.glob(f"*.{run_id}.json"))
        if len(summaries) != 1:
            raise RuntimeError(
                f"official evaluator produced {len(summaries)} run summaries for {run_id}"
            )
        shutil.copyfile(summaries[0], evaluation_dir / "official-summary.json")
    return official_verdict(profile, evaluation_dir)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_run_dir(results_root: Path, alloy_version: str) -> tuple[str, Path]:
    base_id = datetime.now(timezone.utc).strftime(
        f"alloy-{alloy_version}-%Y%m%dT%H%M%S%fZ"
    )
    collision = 0
    while True:
        run_id = base_id if collision == 0 else f"{base_id}-{collision:02d}"
        run_dir = results_root / run_id
        try:
            run_dir.mkdir(parents=True, exist_ok=False)
        except FileExistsError:
            collision += 1
            continue
        return run_id, run_dir


def summarize_run(run_id: str, status: str, started_at: str, **details: object) -> dict:
    completed_at = utc_now()
    elapsed_seconds = (
        datetime.fromisoformat(completed_at) - datetime.fromisoformat(started_at)
    ).total_seconds()
    return {
        "completed_at": completed_at,
        "elapsed_seconds": max(0.0, elapsed_seconds),
        "run_id": run_id,
        "started_at": started_at,
        "status": status,
        **details,
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_run_path_pointer(
    path: Path,
    run_dir: Path,
    run_id: str,
    candidate_commit: str,
    run_token: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pointer = {
        "candidate_commit": candidate_commit,
        "results_root": str(run_dir.parent.resolve()),
        "run_dir": str(run_dir.resolve()),
        "run_id": run_id,
        "run_token": run_token,
        "schema_version": 1,
    }
    with path.open("x", encoding="utf-8") as pointer_file:
        json.dump(pointer, pointer_file, sort_keys=True, separators=(",", ":"))
        pointer_file.write("\n")


def write_command_logs(stdout_path: Path, stderr_path: Path, error: CommandError) -> None:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(error.stdout)
    stderr_path.write_text(error.stderr)


def main(
    argv: list[str] | None = None,
    *,
    _allow_unsafe_execution_for_tests: bool = False,
) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", type=Path, default=PROFILE_PATH)
    parser.add_argument("--alloy-bin", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--candidate-commit", required=True)
    parser.add_argument("--install-manifest", type=Path, required=True)
    parser.add_argument("--results-root", type=Path, default=BENCH_ROOT / "results")
    parser.add_argument("--work-root", type=Path, default=BENCH_ROOT / ".work")
    parser.add_argument("--run-path-file", type=Path)
    parser.add_argument("--run-token")
    parser.add_argument(
        "--venv-python",
        type=Path,
        default=BENCH_ROOT / ".venv" / "bin" / "python",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not args.dry_run and not _allow_unsafe_execution_for_tests:
        print(
            "error: real execution is disabled pending trusted isolation for the agent, evaluator, and results",
            file=sys.stderr,
        )
        return 2
    if (args.run_path_file is None) != (args.run_token is None):
        parser.error("--run-path-file and --run-token must be provided together")
    if args.run_token == "":
        parser.error("--run-token must not be empty")
    profile = load_profile(args.profile, REPO_ROOT)
    candidate = load_candidate_metadata(args.candidate_root, args.candidate_commit)
    install_manifest = load_install_manifest(args.install_manifest)
    alloy_bin = args.alloy_bin.absolute()
    venv_python = args.venv_python.absolute()

    run_id, run_dir = create_run_dir(args.results_root, candidate.alloy_version)
    if args.run_path_file is not None:
        write_run_path_pointer(
            args.run_path_file,
            run_dir,
            run_id,
            candidate.commit,
            args.run_token,
        )
    started_at = utc_now()
    checkout = args.work_root / run_id / "checkout"
    predictions = run_dir / "predictions.jsonl"
    runtime_error = None
    provenance: dict[str, str | None] = {
        "alloy_version": None,
        "model_digest": None,
        "pi_version": None,
        "swebench_version": None,
    }
    environment = None
    try:
        environment = agent_environment(args.work_root / run_id / "agent-state")
        provenance.update(
            probe_live_provenance(alloy_bin, profile, venv_python, environment)
        )
    except Exception as error:
        runtime_error = str(error)
    manifest = {
        "alloy_version": provenance["alloy_version"],
        "base_commit": profile.base_commit,
        "candidate_commit": candidate.commit,
        "candidate_source_root": str(candidate.root),
        "commands": {
            "alloy": alloy_command(alloy_bin, profile.model, "<problem.md contents>"),
            "evaluator": evaluator_command(
                profile, venv_python, predictions.resolve(), run_id
            ),
            "ollama_model_probe": "GET local Ollama /api/tags",
            "runtime_probe": [str(alloy_bin), "--version"],
            "swebench_probe": [
                str(venv_python),
                "-c",
                "import importlib.metadata; print(importlib.metadata.version('swebench'))",
            ],
        },
        "dataset": profile.dataset.name,
        "expected_alloy_version": candidate.alloy_version,
        "expected_model_digest": profile.model_digest,
        "expected_pi_version": candidate.pi_version,
        "expected_swebench_version": profile.swebench_version,
        "install_manifest": install_manifest,
        "instance_id": profile.instance_id,
        "model": profile.model,
        "model_digest": provenance["model_digest"],
        "pi_version": provenance["pi_version"],
        "run_id": run_id,
        "split": profile.split,
        "started_at": started_at,
        "swebench_version": provenance["swebench_version"],
        "timeout_seconds": profile.agent_timeout_seconds,
    }
    write_json(run_dir / "manifest.json", manifest)
    if runtime_error is None:
        drifts = []
        if install_manifest["commit"] != candidate.commit:
            drifts.append(
                "installed candidate commit drift: "
                f"expected {candidate.commit}, observed {install_manifest['commit']}"
            )
        if install_manifest["version"] != candidate.alloy_version:
            drifts.append(
                "installed Alloy version drift: "
                f"expected {candidate.alloy_version}, observed {install_manifest['version']}"
            )
        if provenance["alloy_version"] != candidate.alloy_version:
            drifts.append(
                "Alloy version drift: "
                f"expected {candidate.alloy_version}, observed {provenance['alloy_version']}"
            )
        if provenance["pi_version"] != candidate.pi_version:
            drifts.append(
                f"Pi version drift: expected {candidate.pi_version}, observed {provenance['pi_version']}"
            )
        if provenance["model_digest"] != profile.model_digest:
            drifts.append(
                "Ollama model digest drift: "
                f"expected {profile.model_digest}, observed {provenance['model_digest']}"
            )
        if provenance["swebench_version"] != profile.swebench_version:
            drifts.append(
                "SWE-bench version drift: "
                f"expected {profile.swebench_version}, observed {provenance['swebench_version']}"
            )
        if drifts:
            runtime_error = "; ".join(drifts)
    if runtime_error is not None:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "runtime_failure", started_at, error=runtime_error),
        )
        print(f"error: {runtime_error}", file=sys.stderr)
        return 2

    try:
        instance = load_instance(profile)
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "dataset_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 3

    prompt = build_prompt(instance)
    (run_dir / "problem.md").write_text(prompt)
    if args.dry_run:
        write_json(run_dir / "summary.json", summarize_run(run_id, "dry_run", started_at))
        print(run_dir)
        return 0

    checkout.parent.mkdir(parents=True, exist_ok=True)
    try:
        checkout_instance(instance["repo"], profile.base_commit, checkout)
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "checkout_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 4

    try:
        assert environment is not None
        result = run_alloy(alloy_bin, profile, checkout, prompt, environment)
    except CommandError as error:
        write_command_logs(
            run_dir / "alloy.stdout.log", run_dir / "alloy.stderr.log", error
        )
        status = "agent_timeout" if isinstance(error, CommandTimedOut) else "agent_failure"
        code = 5 if isinstance(error, CommandTimedOut) else 6
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, status, started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return code
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "agent_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 6

    (run_dir / "alloy.stdout.log").write_text(result.stdout)
    (run_dir / "alloy.stderr.log").write_text(result.stderr)
    try:
        patch_text = capture_patch(checkout)
        (run_dir / "model_patch.diff").write_text(patch_text)
        patch_sha = hashlib.sha256(patch_text.encode()).hexdigest()
        prediction = prediction_record(
            profile.instance_id,
            f"alloy-{candidate.alloy_version}/{profile.model}",
            patch_text,
        )
        write_prediction_jsonl(predictions, prediction)
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "patch_capture_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 7

    try:
        evaluation_dir = run_dir / "evaluation"
        verdict = run_official_evaluation(
            profile,
            venv_python,
            predictions,
            run_id,
            args.work_root,
            evaluation_dir,
        )
    except CommandTimedOut as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "evaluator_timeout", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 8
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "evaluator_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 8

    write_json(
        run_dir / "summary.json",
        summarize_run(
            run_id,
            "evaluated",
            started_at,
            instance_id=profile.instance_id,
            model_patch_sha256=patch_sha,
            patch_bytes=len(patch_text.encode()),
            verdict=verdict,
        ),
    )
    print(run_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
