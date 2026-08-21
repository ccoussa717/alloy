import inspect
import io
import unittest

from benchmarks.swebench.coordinator import RunEvidence
from benchmarks.swebench import runner


SHA = "a" * 40


class FakeCoordinator:
    def __init__(self, evidence):
        self.evidence = evidence
        self.calls = []

    def dry_run(self, candidate_commit):
        self.calls.append(("dry_run", candidate_commit))
        return self.evidence

    def release(self, candidate_commit):
        self.calls.append(("release", candidate_commit))
        return self.evidence


class RunnerAdapterTests(unittest.TestCase):
    def test_adapter_selects_one_coordinator_mode_and_reports_result(self):
        for mode, method in (("dry-run", "dry_run"), ("release", "release")):
            with self.subTest(mode=mode):
                output = io.StringIO()
                error = io.StringIO()
                evidence = RunEvidence(
                    "dry_run" if mode == "dry-run" else "evaluated",
                    None if mode == "dry-run" else "unresolved",
                    {"terminal_status": "dry_run" if mode == "dry-run" else "evaluated"},
                    "signature",
                    run_dir="/trusted/results/run-1",
                )
                coordinator = FakeCoordinator(evidence)

                result = runner.run(coordinator, mode, SHA, stdout=output, stderr=error)

                self.assertEqual(result, 0)
                self.assertEqual(coordinator.calls, [(method, SHA)])
                self.assertEqual(output.getvalue(), "/trusted/results/run-1\n")
                self.assertEqual(error.getvalue(), "")

    def test_adapter_never_turns_nonofficial_release_status_into_success(self):
        cases = (
            RunEvidence("evaluated", "invalid", {}, "signature"),
            RunEvidence("evaluator_failure", None, {}, "signature", "bad summary"),
            RunEvidence("runtime_failure", None, {}, None, "cleanup uncertain"),
        )
        for evidence in cases:
            with self.subTest(status=evidence.status, verdict=evidence.verdict):
                error = io.StringIO()
                result = runner.run(
                    FakeCoordinator(evidence),
                    "release",
                    SHA,
                    stdout=io.StringIO(),
                    stderr=error,
                )
                self.assertNotEqual(result, 0)
                if evidence.error:
                    self.assertIn(evidence.error, error.getvalue())

    def test_adapter_rejects_unknown_modes_before_coordinator_use(self):
        coordinator = FakeCoordinator(RunEvidence("dry_run", None, {}, "signature"))
        with self.assertRaisesRegex(ValueError, "mode"):
            runner.run(coordinator, "host", SHA)
        self.assertEqual(coordinator.calls, [])

    def test_direct_runner_cli_is_fail_closed_until_root_launcher_supplies_coordinator(self):
        error = io.StringIO()
        result = runner.main(["dry-run", SHA], stderr=error)
        self.assertEqual(result, 2)
        self.assertIn("trusted host launcher", error.getvalue())

    def test_main_has_no_unsafe_execution_bypass(self):
        parameters = inspect.signature(runner.main).parameters
        self.assertNotIn("_allow_unsafe_execution_for_tests", parameters)
        self.assertEqual(tuple(parameters), ("argv", "stderr"))


if __name__ == "__main__":
    unittest.main()
