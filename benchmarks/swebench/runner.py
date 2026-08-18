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

try:
    from datasets import load_dataset
except ImportError:
    load_dataset = None

DATASET = "SWE-bench/SWE-bench_Lite"
SPLIT = "test"
INSTANCE_ID = "astropy__astropy-12907"
BASE_COMMIT = "d16bfe05a744909de4b27f5875fe0d4ed41ce607"
MODEL = "ollama/qwen3.8-alloy:latest"
OLLAMA_MODEL = "qwen3.8-alloy:latest"
ALLOY_BIN = Path("/home/chappie/.local/bin/alloy")
PRIVATE_FIELDS = {"patch", "test_patch"}
ALLOY_VERSION = "1.1.25"
PI_VERSION = "0.82.1"
SWEBENCH_VERSION = "5.0.0"
MODEL_DIGEST = "116655dae3333016553c60bc7fec60f7a2cacfb7197630f0f176c6891962b6ba"
AGENT_TIMEOUT = 1800
EVALUATOR_TIMEOUT = 2400
BENCH_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BENCH_ROOT.parents[1]


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


def alloy_command(alloy_bin: Path, prompt: str) -> list[str]:
    return [str(alloy_bin), "--model", MODEL, "-p", prompt]


def run_alloy(checkout: Path, prompt: str, environment: dict[str, str]) -> CommandResult:
    return run_command(
        alloy_command(ALLOY_BIN, prompt), checkout, AGENT_TIMEOUT, env=environment
    )


def capture_patch(checkout: Path) -> str:
    patch = run_command(["git", "diff", "--binary", "--no-ext-diff"], checkout, 120).stdout
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


def load_instance() -> dict:
    if load_dataset is None:
        raise RuntimeError("install requirements-swebench.txt in .venv first")
    rows = load_dataset(DATASET, split=SPLIT)
    matches = [row for row in rows if row["instance_id"] == INSTANCE_ID]
    if len(matches) != 1:
        raise RuntimeError(f"expected one dataset row for {INSTANCE_ID}, found {len(matches)}")
    row = matches[0]
    if row["base_commit"] != BASE_COMMIT:
        raise RuntimeError(f"dataset base commit drift for {INSTANCE_ID}")
    return public_instance(dict(row))


def write_prediction_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def evaluator_command(python: Path, predictions: Path, run_id: str) -> list[str]:
    return [
        str(python),
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        DATASET,
        "--split",
        SPLIT,
        "--instance_ids",
        INSTANCE_ID,
        "--predictions_path",
        str(predictions),
        "--max_workers",
        "1",
        "--timeout",
        str(AGENT_TIMEOUT),
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


def probe_runtime_versions(environment: dict[str, str]) -> dict[str, str]:
    result = run_command(
        [str(ALLOY_BIN), "--version"], REPO_ROOT, 30, env=environment
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


def model_digest_from_tags(tags: object) -> str:
    if not isinstance(tags, dict) or not isinstance(tags.get("models"), list):
        raise RuntimeError("Ollama returned an invalid local model inventory")
    for model in tags["models"]:
        if isinstance(model, dict) and model.get("name") == OLLAMA_MODEL:
            digest = model.get("digest")
            if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest):
                return digest
            raise RuntimeError(f"Ollama model {OLLAMA_MODEL} has an invalid digest")
    raise RuntimeError(f"Ollama model {OLLAMA_MODEL} is not installed")


def probe_ollama_model_digest(environment: dict[str, str]) -> str:
    host = _local_ollama_host(environment["OLLAMA_HOST"])
    base_url = host if "://" in host else f"http://{host}"
    endpoint = f"{base_url.rstrip('/')}/api/tags"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(endpoint, timeout=10) as response:
            tags = json.load(response)
    except (OSError, ValueError) as error:
        raise RuntimeError("could not read the local Ollama model inventory") from error
    return model_digest_from_tags(tags)


def probe_live_provenance(python: Path, environment: dict[str, str]) -> dict[str, str]:
    return {
        **probe_runtime_versions(environment),
        "model_digest": probe_ollama_model_digest(environment),
        "swebench_version": probe_swebench_version(python, environment),
    }


def official_verdict(evaluation_dir: Path) -> str:
    path = evaluation_dir / "official-summary.json"
    try:
        report = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("official evaluator summary is missing or invalid") from error
    if not isinstance(report, dict) or report.get("schema_version") != 2:
        raise RuntimeError("official evaluator produced an unsupported summary schema")
    for category in ("infra_failure_ids", "ambiguous_failure_ids", "error_ids"):
        if INSTANCE_ID in report.get(category, []):
            raise RuntimeError(f"official evaluator classified {INSTANCE_ID} in {category}")
    if INSTANCE_ID in report.get("resolved_ids", []):
        return "resolved"
    if INSTANCE_ID in report.get("unresolved_ids", []) or INSTANCE_ID in report.get(
        "empty_patch_ids", []
    ):
        return "unresolved"
    raise RuntimeError(f"official evaluator produced no verdict for {INSTANCE_ID}")


def run_official_evaluation(
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
                evaluator_command(python, predictions.resolve(), run_id),
                scratch,
                EVALUATOR_TIMEOUT,
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
    return official_verdict(evaluation_dir)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_run_dir(results_root: Path) -> tuple[str, Path]:
    base_id = datetime.now(timezone.utc).strftime(f"alloy-{ALLOY_VERSION}-%Y%m%dT%H%M%S%fZ")
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


def write_command_logs(stdout_path: Path, stderr_path: Path, error: CommandError) -> None:
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.write_text(error.stdout)
    stderr_path.write_text(error.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-root", type=Path, default=BENCH_ROOT / "results")
    parser.add_argument("--work-root", type=Path, default=BENCH_ROOT / ".work")
    parser.add_argument(
        "--venv-python",
        type=Path,
        default=BENCH_ROOT / ".venv" / "bin" / "python",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    venv_python = args.venv_python.absolute()

    run_id, run_dir = create_run_dir(args.results_root)
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
        provenance.update(probe_live_provenance(venv_python, environment))
    except Exception as error:
        runtime_error = str(error)
    manifest = {
        "alloy_version": provenance["alloy_version"],
        "base_commit": BASE_COMMIT,
        "commands": {
            "alloy": alloy_command(ALLOY_BIN, "<problem.md contents>"),
            "evaluator": evaluator_command(venv_python, predictions.resolve(), run_id),
            "ollama_model_probe": "GET local Ollama /api/tags",
            "runtime_probe": [str(ALLOY_BIN), "--version"],
            "swebench_probe": [
                str(venv_python),
                "-c",
                "import importlib.metadata; print(importlib.metadata.version('swebench'))",
            ],
        },
        "dataset": DATASET,
        "expected_alloy_version": ALLOY_VERSION,
        "expected_model_digest": MODEL_DIGEST,
        "expected_pi_version": PI_VERSION,
        "expected_swebench_version": SWEBENCH_VERSION,
        "instance_id": INSTANCE_ID,
        "model": MODEL,
        "model_digest": provenance["model_digest"],
        "pi_version": provenance["pi_version"],
        "run_id": run_id,
        "split": SPLIT,
        "started_at": started_at,
        "swebench_version": provenance["swebench_version"],
        "timeout_seconds": AGENT_TIMEOUT,
    }
    write_json(run_dir / "manifest.json", manifest)
    if runtime_error is None:
        drifts = []
        if provenance["alloy_version"] != ALLOY_VERSION:
            drifts.append(
                f"Alloy version drift: expected {ALLOY_VERSION}, observed {provenance['alloy_version']}"
            )
        if provenance["pi_version"] != PI_VERSION:
            drifts.append(
                f"Pi version drift: expected {PI_VERSION}, observed {provenance['pi_version']}"
            )
        if provenance["model_digest"] != MODEL_DIGEST:
            drifts.append(
                "Ollama model digest drift: "
                f"expected {MODEL_DIGEST}, observed {provenance['model_digest']}"
            )
        if provenance["swebench_version"] != SWEBENCH_VERSION:
            drifts.append(
                "SWE-bench version drift: "
                f"expected {SWEBENCH_VERSION}, observed {provenance['swebench_version']}"
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
        instance = load_instance()
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
        checkout_instance(instance["repo"], BASE_COMMIT, checkout)
    except Exception as error:
        write_json(
            run_dir / "summary.json",
            summarize_run(run_id, "checkout_failure", started_at, error=str(error)),
        )
        print(f"error: {error}", file=sys.stderr)
        return 4

    try:
        assert environment is not None
        result = run_alloy(checkout, prompt, environment)
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
        prediction = prediction_record(INSTANCE_ID, f"alloy-{ALLOY_VERSION}/{MODEL}", patch_text)
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
            instance_id=INSTANCE_ID,
            model_patch_sha256=patch_sha,
            patch_bytes=len(patch_text.encode()),
            verdict=verdict,
        ),
    )
    print(run_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
