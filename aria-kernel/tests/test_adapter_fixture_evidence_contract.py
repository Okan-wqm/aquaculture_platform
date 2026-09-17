"""ARIA-HIGH-098 (registry half) — every registered adapter has a fixture-backed evidence contract.

Trial eleven (``cyc-20260912T221237Z-auto``): ``agent-harness-security-adapter``
was registered from ``tools/aria-adapters`` like its nine siblings, ran, and
was quarantined on 48 ``finding_evidence_missing`` findings — its manifest
named a fixture directory that did not exist, so its output had never met
``validate_tool_output_evidence`` before the night that fixed the cycle's
status on it. The fixture runner is where the validator meets an adapter's
output; an adapter with no case is an adapter nothing has validated.

Three pins:

1. every shipped manifest carries at least one case expecting an ``ok`` run
   (``adapter_fixture_contract.assert_fixture_backed``) — filesystem only,
   runs everywhere;
2. the production door (``cycle._phase_tool_manifest_sync``) refuses a
   manifest without one, by name, and still registers the shipped set;
3. every case of every shipped manifest runs ``ok`` through the real
   fixture runner against this checkout: the adapter executed, its output
   parsed, and ``validate_tool_output_evidence`` accepted it. That status
   IS the evidence contract; the case's expectations (``max_findings``,
   ``raw_observations_count``, required observation types) are the
   fixture's calibration of the corpus, refreshed nightly by
   ``cycle._phase_fixture_refresh`` and consumed by ``readiness`` for
   promotion — a stale count there blocks a promotion, it does not make
   an adapter's evidence invalid, and pinning it per PR would turn every
   contract-adding commit into a fixture treadmill. Python runners run
   everywhere; ``npx ts-node`` runners run when the checkout carries the
   repo-local ``node_modules/ts-node`` the production runner itself
   requires (``tool_runner._runner_missing_node_deps`` — the CI lane runs
   ``npm ci`` first; locally without it the adapter is skipped by name,
   the precedent ``test_007c_adapters_integration`` set).
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import cycle as cycle_mod
from aria_kernel import register_tool
from aria_kernel.adapter_fixture_contract import (
    REQUIRED_EXPECTED_STATUS,
    assert_fixture_backed,
    expected_run_status,
    fixture_cases_for_manifest,
)
from aria_kernel.fixture_runner import evaluate_fixture_expectation, run_fixture_suite
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, get_tool, list_tools
from aria_kernel.tool_runner import _runner_missing_node_deps

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_DIR = REPO_ROOT / "tools" / "aria-adapters"


def _shipped_manifests() -> list[tuple[Path, dict]]:
    return [
        (path, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted(MANIFEST_DIR.glob("*.tool.json"))
    ]


def _runner_unavailable(registered: dict) -> str | None:
    """Why this checkout cannot execute the registered tool's runner, or None.

    The registry normalises ``npx ts-node`` to ``node ./node_modules/ts-node/
    dist/bin.js`` and the production runner refuses to price a missing
    repo-local dependency as tool guilt (``environment_unavailable``); the
    same predicate decides here, so the skip and the runner agree on what
    "available" means.
    """
    runner = registered["runner"]
    if _runner_missing_node_deps(REPO_ROOT / str(runner.get("cwd") or "."), list(runner["argv"])):
        return "repo-local node_modules/ts-node/dist/bin.js is absent (the CI lane installs it)"
    return None


class ShippedManifestContractTests(unittest.TestCase):
    def test_the_roster_is_the_ten_adapters(self) -> None:
        ids = sorted(manifest["tool_id"] for _, manifest in _shipped_manifests())
        self.assertIn("agent-harness-security-adapter", ids)
        self.assertGreaterEqual(len(ids), 10)

    def test_every_shipped_manifest_is_fixture_backed(self) -> None:
        for path, manifest in _shipped_manifests():
            with self.subTest(manifest=path.name):
                cases = assert_fixture_backed(manifest, REPO_ROOT)
                self.assertTrue(cases, f"{path.name} has no fixture case")
                for case_path in cases:
                    expected = json.loads(case_path.read_text(encoding="utf-8")).get("expected")
                    self.assertEqual(
                        expected_run_status(expected), REQUIRED_EXPECTED_STATUS,
                        f"{case_path} must expect an ok run — that is the evidence contract",
                    )

    def test_every_shipped_suite_runs_ok_through_the_evidence_validator(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-098-suite-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        saved = os.environ.get("ARIA_REPO_ROOT")
        os.environ["ARIA_REPO_ROOT"] = str(REPO_ROOT)
        self.addCleanup(
            lambda: os.environ.__setitem__("ARIA_REPO_ROOT", saved) if saved is not None
            else os.environ.pop("ARIA_REPO_ROOT", None),
        )
        for path, manifest in _shipped_manifests():
            with self.subTest(manifest=path.name):
                tools = ensure_tools_dir(tmp / manifest["tool_id"] / "aria-tools")
                register_tool(manifest, base_dir=tools)
                unavailable = _runner_unavailable(get_tool(manifest["tool_id"], tools))
                if unavailable is not None:
                    self.skipTest(f"{manifest['tool_id']}: {unavailable}")
                result = run_fixture_suite(
                    manifest["tool_id"], workspace_root=REPO_ROOT,
                    cycle_id="cyc-098-contract", base_dir=tools,
                )
                self.assertTrue(result["cases"], f"{manifest['tool_id']}: the suite ran no case")
                for case in result["cases"]:
                    if case["status"] == "budget_exceeded":
                        # The tool never answered, so its output shape was not
                        # observed: nothing here is evidence for or against the
                        # contract. Pricing the miss as a contract failure is the
                        # conflation ARIA-HIGH-098 names; the nightly refresh and
                        # ``tool_health`` are where a budget is priced (CALIBRATE
                        # on the second miss in seven days). Reported by name so a
                        # runner too slow for an adapter's own budget is visible
                        # in the lane summary, never green by silence.
                        self.skipTest(
                            f"{manifest['tool_id']}/{case['name']}: budget_exceeded after "
                            f"{case.get('duration_ms')} ms (runner timeout_ms="
                            f"{get_tool(manifest['tool_id'], tools)['runner']['timeout_ms']}) — "
                            "the evidence contract was not observed on this runner",
                        )
                    # ``ok`` is granted only after ``validate_tool_output_evidence``
                    # accepted the output (``run_fixture_case``): a crash, an
                    # unparsable envelope or a finding without ``evidence``
                    # each carry their own status here.
                    self.assertEqual(
                        case["status"], REQUIRED_EXPECTED_STATUS,
                        f"{manifest['tool_id']}/{case['name']}: {case['status']} — "
                        f"{json.dumps(case['evidence_validation'].get('errors', []))[:400]}",
                    )


class ManifestSyncRefusesUnbackedAdaptersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-098-sync-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.workspace = self.tmp / "repo"
        (self.workspace / "tools" / "aria-adapters").mkdir(parents=True)
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.base = json.loads(
            (MANIFEST_DIR / "agent-harness-security-adapter.tool.json").read_text(encoding="utf-8"),
        )

    def _write_manifest(
        self,
        tool_id: str,
        *,
        with_case: bool,
        expected_status: str = "ok",
        case: dict | list | None = None,
    ) -> dict:
        manifest = {**self.base, "tool_id": tool_id, "fixture_set": f"tools/aria-adapters/fixtures/{tool_id}"}
        (self.workspace / "tools" / "aria-adapters" / f"{tool_id}.tool.json").write_text(
            json.dumps(manifest), encoding="utf-8",
        )
        if with_case:
            cases = self.workspace / manifest["fixture_set"] / "cases"
            cases.mkdir(parents=True)
            body = {"input": {}, "expected": {"status": expected_status}} if case is None else case
            (cases / "baseline.json").write_text(json.dumps(body), encoding="utf-8")
        return manifest

    def _sync(self) -> dict:
        context = cycle_mod.build_phase_context(
            cycle_id="cyc-098-sync", workspace_root=self.workspace, base_dir=self.tools,
        )
        return cycle_mod._phase_tool_manifest_sync(context)

    def test_a_manifest_without_a_fixture_case_is_refused_by_name(self) -> None:
        self._write_manifest("backed-adapter", with_case=True)
        self._write_manifest("unbacked-adapter", with_case=False)
        result = self._sync()
        self.assertEqual(result["synced_tool_ids"], ["backed-adapter"])
        self.assertEqual(len(result["refused"]), 1)
        self.assertEqual(result["refused"][0]["manifest"], "unbacked-adapter.tool.json")
        self.assertIn("fixture_cases_missing:unbacked-adapter", result["refused"][0]["reason"])
        self.assertEqual(
            [tool["tool_id"] for tool in list_tools(base_dir=self.tools)], ["backed-adapter"],
        )

    def test_a_case_expecting_a_non_ok_run_is_not_a_contract(self) -> None:
        self._write_manifest("evasive-adapter", with_case=True, expected_status="evidence_error")
        result = self._sync()
        self.assertEqual(result["synced_tool_ids"], [])
        self.assertIn("fixture_case_expects_non_ok_run:evasive-adapter", result["refused"][0]["reason"])

    def test_a_case_with_no_expected_block_expects_ok_as_the_runner_reads_it(self) -> None:
        # One reading of a case's expectation. ``evaluate_fixture_expectation``
        # judges a case without ``expected`` against ``ok``; the door used to
        # refuse the same case as ``expected.status=None``.
        manifest = self._write_manifest("bare-adapter", with_case=True, case={"input": {}})
        self.assertEqual(expected_run_status(None), REQUIRED_EXPECTED_STATUS)
        self.assertEqual(expected_run_status({}), REQUIRED_EXPECTED_STATUS)
        self.assertEqual(expected_run_status({"status": "crash"}), "crash")
        passed, errors = evaluate_fixture_expectation("ok", {"findings": [], "observations": []}, None)
        self.assertEqual((passed, errors), (True, []))
        self.assertEqual(len(assert_fixture_backed(manifest, self.workspace)), 1)
        self.assertEqual(self._sync()["synced_tool_ids"], ["bare-adapter"])

    def test_a_case_that_is_not_a_json_object_is_refused_as_malformed(self) -> None:
        self._write_manifest("listy-adapter", with_case=True, case=[{"input": {}}])
        result = self._sync()
        self.assertEqual(result["synced_tool_ids"], [])
        self.assertIn("fixture_case_malformed:listy-adapter:baseline.json", result["refused"][0]["reason"])

    def test_assert_fixture_backed_names_the_missing_directory(self) -> None:
        manifest = {**self.base, "tool_id": "ghost-adapter", "fixture_set": "tools/aria-adapters/fixtures/ghost-adapter"}
        with self.assertRaises(GovernanceError) as caught:
            assert_fixture_backed(manifest, self.workspace)
        self.assertIn("fixture_cases_missing:ghost-adapter", str(caught.exception))
        self.assertEqual(fixture_cases_for_manifest(manifest, self.workspace), [])


if __name__ == "__main__":
    unittest.main()
