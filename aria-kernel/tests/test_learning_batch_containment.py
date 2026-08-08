"""One bad item must cost that item — never the batch.

ORPHAN-HIGH-575 measured the alternative. `plan_downstream_impact` raised
`TypeError` on this repository's most ordinary commit shape, `_impact_graph_compute`
contained only `GovernanceError`, and the exception escaped the loop over EVERY
pending dispatch. Upstream it became one generic `learning_hook_failed`: a single
pressure event disabled impact-graph computation for the whole cycle, under a name
identifying neither the item nor the stage.

Fixing that `TypeError` removed the instance. These tests pin the amplifier's
removal, and they exist per-hook rather than once because containment is a
zero-effort default here, not a structural impossibility — a future bare loop
would inherit the old blast radius, and only a behavioural pin catches that.

Every test below drives the failure through the REAL hook against real fixtures;
the only fake is the raise itself, injected at the one collaborator whose failure
is being contained.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.learning import (
    _impact_graph_compute,
    _skill_or_agent_genesis,
    prune_cycle_artifacts,
    recompute_pressure_decay,
    run_learning_pre_cycle,
)
from aria_kernel.ledger import LedgerIntegrityError, read_jsonl
from aria_kernel.tool_registry import ensure_tools_binding, ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.declared_fixtures import append_declared_fixture


class _InjectedFailure(RuntimeError):
    """A failure class the hooks have no special knowledge of.

    Deliberately NOT a `GovernanceError`: the defect was that the one contained
    type was the only contained type, so a test using the contained type would
    have passed against the broken code.
    """


class ImpactGraphBatchContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        farm = self.repo / "apps" / "farm-service"
        farm.mkdir(parents=True)
        (farm / "project.json").write_text('{"name": "farm-service"}', encoding="utf-8")
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self, event_id: str, assignment_id: str, evidence: list[str]) -> None:
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": event_id,
                "primitive": "REPETITION",
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": evidence,
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="workspace_memory_pressure",
        )
        append_declared_fixture(
            self.tools_dir / "dispatch" / "requests.jsonl",
            {
                "$schema": "aria/dispatch-request/v1",
                "schema_version": 1,
                "assignment_id": assignment_id,
                "pressure_event_id": event_id,
                "state": "pending",
                "created_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="dispatch_requests",
        )

    def test_one_failing_dispatch_does_not_cost_the_others(self):
        self._seed("PE-BAD", "A-bad-aaaa1111", ["apps/farm-service/src/bad.ts"])
        self._seed("PE-GOOD", "A-good-bbbb2222", ["apps/farm-service/src/good.ts"])

        real = __import__("aria_kernel.learning", fromlist=["plan_downstream_impact"]).plan_downstream_impact

        def raise_for_bad(*, changed_files, **kwargs):
            if any("bad.ts" in ref for ref in changed_files):
                raise _InjectedFailure("graph exploded")
            return real(changed_files=changed_files, **kwargs)

        with mock.patch("aria_kernel.learning.plan_downstream_impact", side_effect=raise_for_bad):
            result = _impact_graph_compute(cycle_id="cyc-mixed", paths=self.paths, tools_root=self.tools_dir)

        # The healthy dispatch is still computed — this is the whole point.
        self.assertEqual(result["computed_count"], 1)
        self.assertEqual(result["dispatches"][0]["assignment_id"], "A-good-bbbb2222")

        # And the failure is NAMED, not merely survived.
        self.assertEqual(len(result["item_failures"]), 1)
        failure = result["item_failures"][0]
        self.assertEqual(failure["item_kind"], "dispatch")
        self.assertEqual(failure["item_id"], "A-bad-aaaa1111")
        self.assertEqual(failure["error_class"], "_InjectedFailure")
        self.assertIn("graph exploded", failure["error_message"])

    def test_a_refused_computation_is_not_counted_as_missing_evidence(self):
        """`skipped_no_evidence` must mean only what it says.

        Before this, a `GovernanceError` from the graph incremented the
        no-evidence counter — so an operator reading `skipped_no_evidence: 3`
        could not tell three evidence-less pressures from three refusals. The
        evidence was there; the graph declined it.
        """
        self._seed("PE-REFUSED", "A-ref-cccc3333", ["apps/farm-service/src/x.ts"])
        self._seed("PE-EMPTY", "A-emp-dddd4444", [])

        with mock.patch(
            "aria_kernel.learning.plan_downstream_impact",
            side_effect=_InjectedFailure("refused"),
        ):
            result = _impact_graph_compute(cycle_id="cyc-refused", paths=self.paths, tools_root=self.tools_dir)

        self.assertEqual(result["skipped_no_evidence"], 1, "only the genuinely evidence-less dispatch")
        self.assertEqual([f["item_id"] for f in result["item_failures"]], ["A-ref-cccc3333"])

    def test_a_clean_batch_carries_no_failure_accounting(self):
        # Guards the other direction: containment must not attach an empty
        # failure list to every healthy cycle, which would make `partial`
        # meaningless upstream.
        self._seed("PE-CLEAN", "A-cln-eeee5555", ["apps/farm-service/src/app.ts"])
        result = _impact_graph_compute(cycle_id="cyc-clean", paths=self.paths, tools_root=self.tools_dir)
        self.assertEqual(result["computed_count"], 1)
        self.assertNotIn("item_failures", result)


class GenesisBatchContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_gap(self, event_id: str, capability_gap_key: str) -> None:
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": event_id,
                "primitive": "REPETITION",
                "subtype": "missing routing",
                "capability_gap_key": capability_gap_key,
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": ["apps/farm-service/src/app.ts"],
                "feedback_event_ids": [],
                "detected_at": "2026-05-06T00:00:00Z",
            },
            expected_surface="workspace_memory_pressure",
        )

    def test_one_failing_gap_does_not_suppress_the_rest(self):
        """The worst shape: side effects land, accounting is lost.

        Each gap commits its own ledger row and governance event before the
        next one runs, so a bare loop leaves the earlier writes on disk while
        reporting nothing but a wholesale hook failure — the operator sees a
        failure and cannot tell that two requests were in fact emitted.
        """
        self._seed_gap("PE-G1", "farm:alpha:ts")
        self._seed_gap("PE-G2", "farm:beta:ts")
        self._seed_gap("PE-G3", "farm:gamma:ts")
        detect_capability_gaps(cycle_id="cyc-pre", paths=self.paths, base_dir=self.tools_dir)

        real = __import__("aria_kernel.learning", fromlist=["request_agent_genesis"]).request_agent_genesis
        seen: list[str] = []

        def raise_for_beta(gap, **kwargs):
            key = str(gap.get("capability_gap_key") or "")
            seen.append(key)
            if key == "farm:beta:ts":
                raise _InjectedFailure("genesis exploded")
            return real(gap, **kwargs)

        with mock.patch("aria_kernel.learning.request_agent_genesis", side_effect=raise_for_beta):
            result = _skill_or_agent_genesis(cycle_id="cyc-g", paths=self.paths, tools_root=self.tools_dir)

        self.assertEqual(len(seen), 3, "the loop reached every gap, including the one after the failure")
        self.assertEqual(result["requested_count"], 2)
        self.assertEqual(len(result["item_failures"]), 1)
        self.assertEqual(result["item_failures"][0]["item_kind"], "capability_gap")
        self.assertEqual(result["item_failures"][0]["error_class"], "_InjectedFailure")


class DecayBatchContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)
        self.now = datetime(2026, 5, 5, tzinfo=timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_stale(self, event_id: str) -> None:
        detected_at = self.now - timedelta(days=190)
        append_declared_fixture(
            self.paths.ledgers["pressure"],
            {
                "$schema": "aria/pressure-event/v2",
                "schema_version": 2,
                "event_id": event_id,
                "cycle_id": None,
                "primitive": "UNKNOWN",
                "subtype": "fixture",
                "capability_gap_key": "backend:schema_drift:ts",
                "magnitude": 3,
                "threshold": 3,
                "exceeds_threshold": True,
                "evidence_refs": [],
                "feedback_event_ids": [],
                "evidence_fingerprint": f"sha256:{event_id}",
                "detected_at": detected_at.isoformat().replace("+00:00", "Z"),
                "drives": ["adapter_birth"],
            },
            expected_surface="workspace_memory_pressure",
        )

    def test_one_failing_transition_still_records_the_decays_that_happened(self):
        """A bare loop here undercounts decay telemetry.

        The earlier transitions are already appended to the pressure-state
        ledger when a later one raises; losing the batch loses the
        `pressure_decayed` governance event that reports them, so the state
        changes happened and nothing said so.
        """
        self._seed_stale("PE-D1")
        self._seed_stale("PE-D2")

        real = __import__("aria_kernel.learning", fromlist=["append_pressure_state_event"]).append_pressure_state_event
        calls: list[str] = []

        def raise_for_first(paths, *, pressure, **kwargs):
            event_id = str(pressure.get("event_id") or "")
            calls.append(event_id)
            if event_id == "PE-D1":
                raise _InjectedFailure("state append exploded")
            return real(paths, pressure=pressure, **kwargs)

        with mock.patch("aria_kernel.learning.append_pressure_state_event", side_effect=raise_for_first):
            result = recompute_pressure_decay(self.paths, cycle_id="cyc-d", now=self.now)

        self.assertEqual(sorted(calls), ["PE-D1", "PE-D2"])
        self.assertEqual(result["transition_count"], 1)
        self.assertEqual([f["item_id"] for f in result["item_failures"]], ["PE-D1"])
        kinds = [row["kind"] for row in read_jsonl(self.paths.ledgers["governance"])]
        self.assertIn("pressure_decayed", kinds, "the surviving transition is still reported")


class PruneBatchContainmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)
        self.now = datetime(2026, 5, 5, tzinfo=timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_artifact(self, stem: str) -> None:
        self.paths.cycle_dir.mkdir(parents=True, exist_ok=True)
        (self.paths.cycle_dir / f"{stem}.json").write_text("{}", encoding="utf-8")

    def test_one_unmovable_artifact_does_not_stop_the_prune(self):
        # A permission error, a cross-device rename, a file deleted between the
        # glob and the move: any of them used to leave every LATER artifact
        # unpruned, which is how a disk fills quietly.
        self._seed_artifact("cyc-20200101T000000Z")
        self._seed_artifact("cyc-20200102T000000Z")

        real = __import__("aria_kernel.learning", fromlist=["_archive_workspace_artifact"])._archive_workspace_artifact

        def raise_for_first(paths, artifact, artifact_at, cycle_id):
            if artifact.stem == "cyc-20200101T000000Z":
                raise _InjectedFailure("cross-device link")
            return real(paths, artifact, artifact_at, cycle_id)

        with mock.patch("aria_kernel.learning._archive_workspace_artifact", side_effect=raise_for_first):
            result = prune_cycle_artifacts(self.paths, cycle_id="cyc-now", now=self.now)

        self.assertEqual(result["archived_count"], 1)
        self.assertEqual([f["item_id"] for f in result["item_failures"]], ["cyc-20200101T000000Z.json"])
        self.assertEqual(result["item_failures"][0]["item_kind"], "workspace_artifact")


class ReportIngestionRetryTests(unittest.TestCase):
    """Containment must not consume the item it failed to process."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_registry(self, ids: list[str]) -> None:
        registry = self.repo / "docs" / "reviews" / "_registry"
        registry.mkdir(parents=True, exist_ok=True)
        registry.joinpath("findings.jsonl").write_text(
            "".join(
                json.dumps({
                    "id": finding_id,
                    "severity": "HIGH",
                    "state": "OPEN",
                    "title": f"title {finding_id}",
                    "review_file": "docs/reviews/x.md",
                    "owner_agent": "aria-acceptance-gap-hunter",
                }) + "\n"
                for finding_id in ids
            ),
            encoding="utf-8",
        )

    def _run(self) -> dict:
        from aria_kernel import report_ingestion
        return report_ingestion.report_ingestion_scan(
            self.paths, cycle_id="cyc-ri", tools_root=self.tools_dir,
        )

    def test_a_finding_that_failed_to_ingest_is_offered_again_next_cycle(self):
        """The regression per-item containment could have introduced.

        Before containment, a raise propagated out of the hook and the dedup
        cache was never written, so nothing was marked seen. With containment
        the hook now always reaches `_write_cache` — so marking a finding seen
        before ingesting it would drop that finding permanently and silently.
        It joins `known` only after it is actually ingested.
        """
        from aria_kernel import report_ingestion

        self._write_registry(["X-1"])
        baseline = self._run()
        self.assertEqual(baseline["status"], "baselined")

        # A finding that appears AFTER the baseline is a real candidate.
        self._write_registry(["X-1", "X-2"])
        with mock.patch.object(
            report_ingestion, "_ingest_one_finding", side_effect=_InjectedFailure("boom"),
        ):
            failed = self._run()
        self.assertEqual([f["item_id"] for f in failed["item_failures"]], ["X-2"])
        self.assertEqual(failed["ingested_count"], 0)

        # Containment did not eat it: the next cycle offers X-2 again.
        retried = self._run()
        self.assertEqual(retried["ingested_count"], 1)
        self.assertEqual(retried["ingested"][0]["finding_key"], "X-2")
        self.assertNotIn("item_failures", retried)


class HookRunnerPartialStatusTests(unittest.TestCase):
    """Containment must not trade a loud failure for a silent one."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.paths = workspace_paths(self.repo, Path(self.tmp.name) / "workspaces")
        ensure_workspace(self.paths)
        self.tools_dir = ensure_tools_binding(Path(self.tmp.name) / "aria-tools", workspace_root=self.repo)
        self.now = datetime(2026, 5, 5, tzinfo=timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def _contained_failure_payload(self, paths, *, cycle_id, **kwargs):
        return {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "ttl_days": 365,
            "archived_count": 0,
            "archived": [],
            "item_failures": [
                {
                    "item_kind": "workspace_artifact",
                    "item_id": "cyc-20200101T000000Z.json",
                    "error_class": "_InjectedFailure",
                    "error_message": "cross-device link",
                },
            ],
        }

    def test_a_hook_that_lost_items_is_reported_partial_not_ok(self):
        with mock.patch("aria_kernel.learning.prune_cycle_artifacts", side_effect=self._contained_failure_payload):
            result = run_learning_pre_cycle(
                self.paths, cycle_id="cyc-partial", tools_root=self.tools_dir, now=self.now,
            )

        prune = next(row for row in result["hooks"] if row["hook_name"] == "artifact_prune")
        self.assertEqual(prune["status"], "partial")
        self.assertTrue(prune["governance_event_id"])

        events = [row for row in read_jsonl(self.paths.ledgers["governance"]) if row["kind"] == "learning_hook_items_failed"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["details"]["hook_name"], "artifact_prune")
        self.assertEqual(events[0]["details"]["failure_count"], 1)
        self.assertEqual(events[0]["details"]["failures"][0]["error_class"], "_InjectedFailure")

    def test_a_clean_hook_stays_ok_and_writes_no_failure_event(self):
        result = run_learning_pre_cycle(
            self.paths, cycle_id="cyc-ok", tools_root=self.tools_dir, now=self.now,
        )
        self.assertTrue(all(row["status"] == "ok" for row in result["hooks"]))
        kinds = [row["kind"] for row in read_jsonl(self.paths.ledgers["governance"])]
        self.assertNotIn("learning_hook_items_failed", kinds)

    def test_ledger_corruption_escapes_containment_from_inside_an_item(self):
        """The one failure a cycle must abort on.

        `_run_learning_hooks` re-raises `LedgerIntegrityError` deliberately. The
        raise must therefore come from INSIDE an item's work, not from the hook
        call — otherwise this test would pin the runner's pre-existing behaviour
        and say nothing about whether per-item containment swallows a corrupt
        ledger, which is exactly the demotion that would let a cycle carry on
        writing to it.
        """
        self.paths.cycle_dir.mkdir(parents=True, exist_ok=True)
        (self.paths.cycle_dir / "cyc-20200101T000000Z.json").write_text("{}", encoding="utf-8")

        with mock.patch(
            "aria_kernel.learning._archive_workspace_artifact",
            side_effect=LedgerIntegrityError("chain broken"),
        ):
            with self.assertRaises(LedgerIntegrityError):
                prune_cycle_artifacts(self.paths, cycle_id="cyc-corrupt", now=self.now)


if __name__ == "__main__":
    unittest.main()
