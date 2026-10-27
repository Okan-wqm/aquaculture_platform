"""F0.9p — the doctor reads the provenance census every run, so a learned row without a source is a finding.

WHY THIS EXISTS. ``row_provenance.provenance_census`` (tests/test_row_provenance.py) counts the learned memory rows
that name no source. A census nobody calls is dead code, and the ownership atlas's own liveness model reads a family
no cycle phase, workflow script or CLI reaches as ``dead`` (tests/test_ownership_atlas_provenance.py): the doctor
(``aria-kernel doctor``, every organ a pure read) is the reader that makes it live.

THE API THIS PINS (new in F0.9p; at the branch base ``doctor`` has no such organ, so each test reports an assertion
failure, not an AttributeError):
  organ ``provenance``, registered in ``run_doctor``'s store checks right after ``learning``;
  ``doctor._check_provenance(tools_dir) -> DoctorCheck``
    status is ONLY ``ok`` or ``warn``, NEVER ``fail``: legacy rows on the live store cannot be rewritten (memory_class
    forbids history rewrite), so a ``fail`` could never clear and would turn every doctor run red for good.
    ``warn`` reason ``orphan_memory:<kind>=<n>[,<kind>=<n>...]`` (kinds sorted, only kinds with orphans, n = ALL the
    kind's orphans); ``ok`` reason ``""``, or ``no_memory_rows`` when all three kinds have zero rows.
    ``detail = {kind: {"rows": n, "orphans": first 20}}``: ids and reason codes only, no row content.
  An unreadable ledger is the doctor's existing contract (``_guarded``): ``warn`` + ``check_unreadable:<ExceptionName>``,
  with ``probe_fault`` naming the exception. The organ must raise the owner's error, not swallow it into ``ok``.
  An unbound tools root keeps its existing path (``tools_root_unbound`` and the host checks), with no store organ.

The host checks (providers, sandbox, Claude CLI, habitat) are stubbed: they probe the machine, and a doctor run starts
the egress proxy of one of them. They are not the subject here; only the new organ is claimed read-only.
Fixtures are built through the owners' writers (tests/test_row_provenance.py).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import doctor
from aria_kernel.doctor import DoctorCheck, DoctorReport, run_doctor
from aria_kernel.knowledge_graph import KnowledgeGraphTamper
from aria_kernel.tool_registry import ensure_tools_dir
from tests.test_row_provenance import seed_belief, seed_convention, seed_episode, seed_plans, snapshot

_KINDS = ("belief", "convention", "episode")
_HOST_CHECKS = {"_check_providers": "providers", "_check_sandbox": "sandbox_backend", "_check_claude_cli": "claude_cli",
                "_check_habitat": "habitat"}


class ProvenanceOrganCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.tools = self.root / "aria-tools"
        ensure_tools_dir(self.tools)

    def report(self, base_dir: Path | None = None) -> DoctorReport:
        stubs = {attr: mock.Mock(return_value=DoctorCheck(name, "ok")) for attr, name in _HOST_CHECKS.items()}
        with mock.patch.multiple(doctor, **stubs):
            return run_doctor(base_dir=self.tools if base_dir is None else base_dir, workspace_root=self.root)

    @staticmethod
    def organ(report: DoctorReport) -> DoctorCheck:
        found = [check for check in report.checks if check.name == "provenance"]
        if not found:
            raise AssertionError("F0.9p: run_doctor has no 'provenance' organ")
        return found[0]

    def probe(self) -> DoctorCheck:
        check = getattr(doctor, "_check_provenance", None)
        if check is None:
            raise AssertionError("F0.9p: aria_kernel.doctor._check_provenance does not exist")
        return check(self.tools)

    def seed_orphan_per_kind(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_dangling", plan_id="plan-gone")
        seed_episode(self.tools, "e_dangling", plan_id="plan-gone")
        seed_belief(self.tools, "b_empty", [])


class TheOrganWarnsOnOrphansAndNeverFails(ProvenanceOrganCase):
    def test_an_orphan_convention_is_a_warn_that_names_the_kind_and_carries_the_row_and_the_reason(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_dangling", plan_id="plan-gone")
        check = self.organ(self.report())
        self.assertEqual((check.status, check.reason), ("warn", "orphan_memory:convention=1"))
        self.assertEqual(check.detail["convention"], {
            "rows": 1, "orphans": [{"row_id": "conv_dangling", "reason": "source_unresolved:plan_id"}],
        })
        self.assertEqual(check.detail["belief"], {"rows": 0, "orphans": []})
        self.assertEqual(check.detail["episode"], {"rows": 0, "orphans": []})

    def test_orphans_in_every_kind_are_one_warn_with_the_kinds_sorted_and_never_a_fail(self) -> None:
        self.seed_orphan_per_kind()
        report = self.report()
        check = self.organ(report)
        self.assertEqual((check.status, check.reason), ("warn", "orphan_memory:belief=1,convention=1,episode=1"))
        self.assertNotIn("provenance", [c.name for c in report.checks if c.status == "fail"])
        self.assertEqual(self.probe().status, "warn")

    def test_only_kinds_with_orphans_are_named(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_ok", plan_id="plan-1")
        seed_episode(self.tools, "e_gone", plan_id="plan-gone")
        seed_belief(self.tools, "b_empty", [])
        check = self.probe()
        self.assertEqual((check.status, check.reason), ("warn", "orphan_memory:belief=1,episode=1"))
        self.assertEqual(check.detail["convention"], {"rows": 1, "orphans": []})

    def test_the_reason_counts_every_orphan_and_the_detail_carries_the_first_twenty(self) -> None:
        seed_plans(self.tools, "plan-1")
        for index in reversed(range(25)):
            seed_convention(self.tools, f"conv_{index:02d}", plan_id="plan-gone")
        check = self.probe()
        self.assertEqual(check.reason, "orphan_memory:convention=25")
        self.assertEqual(check.detail["convention"]["rows"], 25)
        self.assertEqual([orphan["row_id"] for orphan in check.detail["convention"]["orphans"]],
                         [f"conv_{index:02d}" for index in range(20)])

    def test_the_detail_is_ids_and_reason_codes_only(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_belief(self.tools, "b_leaky", [])
        seed_convention(self.tools, "conv_leaky", plan_id="plan-gone")
        detail = self.probe().detail
        for kind in _KINDS:
            for orphan in detail[kind]["orphans"]:
                self.assertEqual(set(orphan), {"row_id", "reason"})
        text = json.dumps(detail)
        self.assertNotIn("claim of b_leaky", text, "a belief's claim text reached the doctor report")
        self.assertNotIn("a.py:1", text, "a convention's evidence reached the doctor report")


class TheOrganIsOkWhenNothingIsOrphaned(ProvenanceOrganCase):
    def test_a_store_whose_rows_are_all_sourced_is_ok_with_no_reason(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_ok", plan_id="plan-1")
        seed_episode(self.tools, "e1", plan_id="plan-1")
        seed_belief(self.tools, "b1", ["x.py"])
        check = self.probe()
        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual(check.detail, {kind: {"rows": 1, "orphans": []} for kind in _KINDS})

    def test_one_kind_with_rows_is_enough_to_have_no_reason(self) -> None:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_ok", plan_id="plan-1")
        check = self.probe()
        self.assertEqual((check.status, check.reason), ("ok", ""))

    def test_an_empty_store_is_ok_and_says_there_are_no_memory_rows_and_the_organ_follows_learning(self) -> None:
        report = self.report()
        check = self.organ(report)
        self.assertEqual((check.status, check.reason), ("ok", "no_memory_rows"))
        self.assertEqual(check.detail, {kind: {"rows": 0, "orphans": []} for kind in _KINDS})
        names = [c.name for c in report.checks]
        self.assertEqual(names.index("provenance"), names.index("learning") + 1,
                         "the organ is registered in the store checks right after 'learning'")
        self.assertEqual(names.count("provenance"), 1)


class TheOrganReadsAndDoesNotRepair(ProvenanceOrganCase):
    def corrupt_conventions(self) -> Path:
        seed_plans(self.tools, "plan-1")
        seed_convention(self.tools, "conv_one", plan_id="plan-1")
        path = self.tools / "knowledge-graph" / "conventions.jsonl"
        path.write_text(path.read_text(encoding="utf-8") + "this line is not json\n", encoding="utf-8")
        return path

    def test_an_unreadable_ledger_is_a_warn_naming_the_owners_error_not_an_ok_and_not_an_orphan(self) -> None:
        self.corrupt_conventions()
        check = self.organ(self.report())
        self.assertEqual((check.status, check.reason), ("warn", "check_unreadable:KnowledgeGraphTamper"))
        self.assertEqual(check.probe_fault, "KnowledgeGraphTamper")

    def test_the_probe_leaves_the_store_exactly_as_it_found_it(self) -> None:
        self.seed_orphan_per_kind()
        before = snapshot(self.root)
        self.assertEqual(self.probe().status, "warn")
        self.assertEqual(snapshot(self.root), before, "the organ wrote to the store (a lock, a rename, an append)")

    def test_the_probe_raises_on_a_corrupt_ledger_and_leaves_the_file_alone(self) -> None:
        path = self.corrupt_conventions()
        before = snapshot(self.root)
        with self.assertRaises(KnowledgeGraphTamper):
            self.probe()
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual([p.name for p in path.parent.iterdir() if ".quarantined." in p.name], [],
                         "the organ quarantined the ledger it was only asked to read")


class AnUnboundToolsRootIsUnchanged(ProvenanceOrganCase):
    def test_there_is_no_store_organ_and_the_existing_finding_and_host_checks_stay(self) -> None:
        report = self.report(self.root / "nowhere")
        names = [check.name for check in report.checks]
        self.assertNotIn("provenance", names)
        self.assertEqual(report.checks[0].reason, "tools_root_unbound")
        for host in _HOST_CHECKS.values():
            self.assertIn(host, names)
        self.assertFalse((self.root / "nowhere").exists())


if __name__ == "__main__":
    unittest.main()
