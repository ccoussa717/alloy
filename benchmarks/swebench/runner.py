from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from benchmarks.swebench.coordinator import TrustedCoordinator


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


def load_candidate_metadata(
    candidate_root: Path, candidate_commit: str
) -> CandidateMetadata:
    if FULL_GIT_SHA.fullmatch(candidate_commit) is None:
        raise RuntimeError("candidate must specify a full candidate commit as a lowercase Git SHA")
    root = candidate_root.resolve()
    try:
        package = json.loads((root / "package.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("candidate package.json is missing or invalid") from error
    if not isinstance(package, dict):
        raise RuntimeError("candidate package.json must be a JSON object")
    alloy_version = package.get("version")
    alloy = package.get("alloy")
    pi_fork = alloy.get("piFork") if isinstance(alloy, dict) else None
    pi_version = pi_fork.get("version") if isinstance(pi_fork, dict) else None
    if not isinstance(alloy_version, str) or SEMANTIC_VERSION.fullmatch(alloy_version) is None:
        raise RuntimeError("candidate Alloy version must be semantic")
    if not isinstance(pi_version, str) or SEMANTIC_VERSION.fullmatch(pi_version) is None:
        raise RuntimeError("candidate Pi version must be semantic")
    return CandidateMetadata(alloy_version, pi_version, candidate_commit, root)


def run(
    coordinator: TrustedCoordinator,
    mode: str,
    candidate_commit: str,
    *,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    if mode == "dry-run":
        evidence = coordinator.dry_run(candidate_commit)
    elif mode == "release":
        evidence = coordinator.release(candidate_commit)
    else:
        raise ValueError("runner mode must be dry-run or release")
    if evidence.run_dir is not None:
        print(evidence.run_dir, file=stdout)
    if evidence.error is not None:
        print(f"error: {evidence.error}", file=stderr)
    return evidence.exit_code


def main(
    argv: list[str] | None = None,
    stderr: TextIO = sys.stderr,
) -> int:
    parser = argparse.ArgumentParser(description="Trusted SWE-bench coordinator adapter")
    parser.add_argument("mode", choices=("dry-run", "release"))
    parser.add_argument("candidate_commit")
    parser.parse_args(argv)
    print(
        "error: direct runner execution is forbidden; use the trusted host launcher",
        file=stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
