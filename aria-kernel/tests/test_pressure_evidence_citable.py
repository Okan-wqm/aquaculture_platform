"""ARIA-HIGH-384 — the kernel never mints evidence its own response law refuses.

MEASURED (aria/state, 2026-10-05..08). Every ``aria-autonomy-planner`` request
minted from a ``pipeline_stalled`` pressure was rejected: four of four
(AIR-aria-autonomy-planner-70499fdb4f52, -e0677ef82cfc, -648a7566ae76,
-71ec6fd28072), each on ``knowledge-graph/pressure-source-effectiveness.jsonl:
f_finding`` — ``agent_evidence_ref_malformed``, ``agent_evidence_path_missing``,
``agent_evidence_not_repo_verified``. The pressure named a tools-root state
ledger as its evidence, the autonomy projection copied it into the envelope's
``evidence_refs``, the planner cited it, and the submit law grades refs against
the repository. The most urgent pressure ARIA has was unanswerable by
construction. The same live ledger holds the class from six more sources:
``pr-<n>:<sha>`` (own_pr_ci, post_merge_ci, repo_pr_health),
``aria-tools/memory/*.jsonl`` (contradiction, uncertainty_repeat), and an
absolute store path (discovery_incomplete).

WHAT these pin:

* the checkout-free half of the agent law (``agent_ref_shape_refusal``)
  refuses every live ref of the class, and never refuses a ref the submit law
  would admit;
* ``pressure._pressure`` refuses a non-citable evidence ref by name and carries
  it as ``provenance_refs``;
* EVERY registered pressure source, fired, emits evidence the full law admits
  at a committed tree, and its non-repo origin on the provenance channel;
* the autonomy projection hands the planner only refs the law admits at the
  envelope's ``target_sha`` — a stored pre-fix payload included — and carries
  reason and provenance as prompt data.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import autonomy_orchestrator as ao
from aria_kernel import pressure as pressure_mod
from aria_kernel.evidence_validator import (
    _check_agent_ref,
    admissible_agent_evidence_refs,
    agent_ref_shape_refusal,
    parse_evidence_ref,
)
from aria_kernel.funnel_health import FUNNEL_STAGES
from aria_kernel.pressure import SOURCE_WEIGHTS, run_pressure
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.git_fixtures import commit_files, make_local_git_repo

_REPO = Path(__file__).resolve().parents[2]
_LEDGER_REF = "knowledge-graph/pressure-source-effectiveness.jsonl:f_finding"

# Every non-repo ref the live request ledger carried into a planner envelope.
LIVE_UNCITABLE_REFS: dict[str, str] = {
    _LEDGER_REF: "agent_evidence_ref_malformed",
    "pr-1335:HEAD": "agent_evidence_ref_malformed",
    "pr-1671:2f6378c52a93884b64c95f29e518fc7595f1f6d3": "agent_evidence_ref_malformed",
    "pr-1022:fix/production-host-control-plane": "agent_evidence_ref_malformed",
    "aria-tools/memory/uncertainties.jsonl": "agent_evidence_self_output",
    "aria-tools/memory/contradictions.jsonl": "agent_evidence_self_output",
    "/home/gharunner/.aria-state-store/tools/discovery/c1/COMPLETION_PROOF.json":
        "agent_evidence_path_escapes_workspace",
}


def _git_head(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, text=True, capture_output=True, check=True,
    ).stdout.strip()


def _fixture_repo_from_real_files(tmp: Path, refs: list[str]) -> Path:
    """A committed repository holding the real repo's bytes for every path in ``refs``.

    Copying (rather than grading the live checkout) keeps the test hermetic
    and indifferent to local edits; reading the real file proves each cited
    path exists in this repository.
    """
    repo = make_local_git_repo(tmp, name="fixture")
    files: dict[str, str] = {}
    for ref in refs:
        parsed = parse_evidence_ref(ref)
        assert parsed is not None, ref
        files[parsed[0]] = (_REPO / parsed[0]).read_text(encoding="utf-8")
    commit_files(repo, files)
    return repo


class TheShapeLawIsTheSubmitLawsPrefix(unittest.TestCase):
    def test_every_live_ref_of_the_class_is_refused_by_name(self) -> None:
        for ref, code in LIVE_UNCITABLE_REFS.items():
            with self.subTest(ref=ref):
                self.assertEqual(agent_ref_shape_refusal(ref), code)

    def test_a_ref_the_shape_law_refuses_the_submit_law_refuses_too(self) -> None:
        # Soundness: the mint never refuses a relative ref an answer could
        # have cited. (An absolute spelling is refused by the shape law alone,
        # by design — see agent_ref_shape_refusal.)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "aria-tools" / "memory").mkdir(parents=True)
            (root / "aria-tools" / "memory" / "uncertainties.jsonl").write_text("{}\n", encoding="utf-8")
            for ref, _code in LIVE_UNCITABLE_REFS.items():
                if ref.startswith("/"):
                    continue
                with self.subTest(ref=ref):
                    errors: list[dict[str, Any]] = []
                    _check_agent_ref(ref, root=root, errors=errors, checked=[])
                    self.assertTrue(errors, f"the submit law admitted {ref!r}")

    def test_repo_refs_and_ledger_pointers_pass(self) -> None:
        for ref in ("aria-kernel/aria_kernel/funnel_health.py", "Cargo.toml:1",
                    "apps/**/*.entity.ts", "human-required:AIR-x-1"):
            with self.subTest(ref=ref):
                self.assertIsNone(agent_ref_shape_refusal(ref))


class APressureCannotBeBuiltWithUncitableEvidence(unittest.TestCase):
    def _build(self, **overrides: Any) -> dict[str, Any]:
        kwargs: dict[str, Any] = dict(
            cycle_id="c1", source="pipeline_stalled", pressure_type="UNKNOWN", severity="critical",
            reason="stalled", evidence=[], occurrence_count=1, candidate_tools=[],
            recommended_action="diagnose",
        )
        kwargs.update(overrides)
        return pressure_mod._pressure(**kwargs)

    def test_the_live_pipeline_stalled_ref_is_refused_as_evidence(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "pressure_evidence_not_agent_citable"):
            self._build(evidence=[_LEDGER_REF])

    def test_every_live_ref_rides_as_provenance(self) -> None:
        row = self._build(provenance_refs=list(LIVE_UNCITABLE_REFS))
        self.assertEqual(row["evidence"], [])
        self.assertEqual(row["provenance_refs"], list(LIVE_UNCITABLE_REFS))


class EverySourceEmitsCitableEvidence(unittest.TestCase):
    """Fire every registered pressure source and judge what each one emits."""

    REPO_REF = "aria-kernel/aria_kernel/funnel_health.py:30"

    def _fire_every_source(self, tools: Path) -> list[dict[str, Any]]:
        cycle = "cyc-all"
        discovery = tools / "discovery" / cycle
        discovery.mkdir(parents=True)
        (discovery / "REPO_FINGERPRINT.json").write_text(json.dumps({
            "migration_count": 6,
            "migration_evidence_paths": [self.REPO_REF, "aria-tools/discovery/x.json"],
        }), encoding="utf-8")
        ledgers = {
            "beliefs.jsonl": [
                {"belief_id": "b-stale", "status": "stale", "evidence_refs": [self.REPO_REF, "pr-12:HEAD"]},
                {"belief_id": "b-gone", "status": "needs_revalidation",
                 "evidence_state": {"missing_concrete_refs": ["x"]}, "evidence_refs": [self.REPO_REF]},
                {"belief_id": "b-reval", "status": "needs_revalidation", "evidence_refs": [self.REPO_REF]},
            ],
            "contradictions.jsonl": [{"status": "open"}],
            "uncertainties.jsonl": [{"kind": "k", "pressure_id": "p"}] * 3,
        }

        def fake_load(path: Path) -> list[dict[str, Any]]:
            return [dict(row) for row in ledgers.get(Path(path).name, [])]

        reds = [{"pr_number": 7, "head_sha": "abc", "head_ref": "fix/x", "merge_sha": "def",
                 "author": "dependabot", "red_jobs": ["ci"]}]
        runs = [
            {"cycle_id": cycle, "status": "evidence_error", "tool_id": "t-q",
             "read_paths": [self.REPO_REF, "aria-tools/runs/x.json"]},
            {"cycle_id": cycle, "status": "ok", "tool_id": "t-s", "read_paths": [self.REPO_REF]},
        ]
        stalled_rows = [
            {"source_type": "f_finding", "cycles_minted": 50, "cycles_converged": 0, "cycles_merged": 0},
            {"source_type": "failing_ci", "cycles_minted": 50, "cycles_converged": 20, "cycles_merged": 0},
        ]
        signals = [{"severity": "high", "source": "sentry", "service": "farm-service", "summary": "500s",
                    "code_refs": [self.REPO_REF, "https://sentry.example/issue/1"]}]
        with patch.object(pressure_mod, "load_jsonl", side_effect=fake_load), \
             patch.object(pressure_mod, "list_tools", return_value=[{"tool_id": "t-q"}, {"tool_id": "t-s"}]), \
             patch.object(pressure_mod, "read_runs_rows", return_value=runs), \
             patch.object(pressure_mod, "_raw_finding_delta", return_value=3), \
             patch("aria_kernel.own_pr_ci.load_open_own_pr_reds", return_value=reds), \
             patch("aria_kernel.own_pr_ci.load_post_merge_reds", return_value=reds), \
             patch("aria_kernel.own_pr_ci.load_third_party_pr_reds", return_value=reds), \
             patch("aria_kernel.knowledge_graph.rank_pressure_sources", return_value=stalled_rows), \
             patch("aria_kernel.runtime_signal_bridge.load_open_runtime_signals", return_value=signals):
            return run_pressure(cycle_id=cycle, base_dir=tools)["pressures"]

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.pressures = self._fire_every_source(ensure_tools_dir(self.tmp / "aria-tools"))

    def test_the_fixture_fires_every_registered_source(self) -> None:
        # A source added to SOURCE_WEIGHTS without a firing here fails this
        # test, so the evidence assertions below always cover the whole table.
        self.assertEqual({p["source"] for p in self.pressures}, set(SOURCE_WEIGHTS))

    def test_every_evidence_ref_passes_the_shape_the_agent_law_admits(self) -> None:
        # Construction-time guarantee for every source. Whether a data-derived
        # ref still names a committed blob is judged at the projection, at the
        # envelope's target_sha (TheProjectionHandsThePlannerOnlyCitableRefs).
        for p in self.pressures:
            for ref in p["evidence"]:
                with self.subTest(source=p["source"], ref=ref):
                    self.assertIsNone(agent_ref_shape_refusal(ref))

    def test_every_evidence_ref_is_admitted_by_the_agent_law_at_a_committed_tree(self) -> None:
        refs = sorted({ref for p in self.pressures for ref in p["evidence"]})
        repo = _fixture_repo_from_real_files(self.tmp, refs)
        verdict = admissible_agent_evidence_refs(refs, workspace_root=repo, target_sha=_git_head(repo))
        self.assertEqual(verdict.refused, ())
        self.assertEqual(sorted(verdict.admitted), refs)

    def test_every_non_repo_origin_rides_as_provenance(self) -> None:
        provenance: dict[str, list[str]] = {}
        for p in self.pressures:
            provenance.setdefault(p["source"], []).extend(p["provenance_refs"])
        self.assertEqual(sorted(provenance["pipeline_stalled"]), [
            "knowledge-graph/pressure-source-effectiveness.jsonl:f_finding",
            "knowledge-graph/pressure-source-effectiveness.jsonl:failing_ci",
        ])
        self.assertEqual(provenance["own_pr_ci"], ["pr-7:abc"])
        self.assertEqual(provenance["post_merge_ci"], ["pr-7:def"])
        self.assertEqual(provenance["repo_pr_health"], ["pr-7:fix/x"])
        self.assertEqual(provenance["contradiction"], ["aria-tools/memory/contradictions.jsonl"])
        self.assertEqual(provenance["uncertainty_repeat"], ["aria-tools/memory/uncertainties.jsonl"])
        self.assertTrue(provenance["discovery_incomplete"][0].endswith("COMPLETION_PROOF.json"))
        # Data-derived sources keep the lead their record named, off the
        # evidence channel.
        self.assertEqual(provenance["migration_surface_repeat"], ["aria-tools/discovery/x.json"])
        self.assertEqual(provenance["belief_stale"], ["pr-12:HEAD"])
        self.assertEqual(provenance["runtime_signal"], ["https://sentry.example/issue/1"])
        self.assertEqual(provenance["tool_quarantine"], ["aria-tools/runs/x.json"])

    def test_a_stalled_stage_cites_the_code_that_moves_work_through_it(self) -> None:
        owners = {stage: list(paths) for stage, _field, paths in FUNNEL_STAGES}
        stalled = sorted(
            (p for p in self.pressures if p["source"] == "pipeline_stalled"),
            key=lambda p: p["pressure_id"],
        )
        self.assertEqual([p["evidence"] for p in stalled], [owners["convergence"], owners["merge"]])

    def test_every_literal_owner_path_is_tracked_in_this_repository(self) -> None:
        literal = [path for _stage, _field, paths in FUNNEL_STAGES for path in paths]
        literal.append(pressure_mod.DISCOVERY_OWNER_PATH)
        for path in literal:
            with self.subTest(path=path):
                tracked = subprocess.run(
                    ["git", "ls-files", "--error-unmatch", path], cwd=_REPO, capture_output=True,
                )
                self.assertEqual(tracked.returncode, 0, f"{path} is not a tracked file")


class TheProjectionHandsThePlannerOnlyCitableRefs(unittest.TestCase):
    """The drain, fed the live pipeline_stalled payload in both shapes."""

    OWNERS = list(FUNNEL_STAGES[0][2])
    PRESSURE_ID = "pressure:pipeline-stalled:funnel-convergence-f-finding"

    def _drain(self, pressure: dict[str, Any], *, committed: bool) -> tuple[dict[str, Any], list, int]:
        captured: dict[str, Any] = {}
        governance: list[tuple[str, dict[str, Any]]] = []
        consumed: list[str] = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "pressure").mkdir()
            (root / "pressure" / "cyc-1.json").write_text(json.dumps({"pressures": [pressure]}), encoding="utf-8")
            workspace = make_local_git_repo(root, name="repo", initial_commit=committed)
            files = {path: (_REPO / path).read_text(encoding="utf-8") for path in self.OWNERS}
            if committed:
                commit_files(workspace, files)
            else:
                # Present on disk, no commit to grade them at: the host
                # cannot verify, which says nothing about the pressure.
                for rel, text in files.items():
                    (workspace / rel).parent.mkdir(parents=True, exist_ok=True)
                    (workspace / rel).write_text(text, encoding="utf-8")
            item = {"queue_item_id": "qi-stall", "pressure_id": self.PRESSURE_ID, "source_cycle_id": "cyc-1",
                    "recommended_action": "diagnose", "candidate_tools": []}

            def fake_create(**kwargs: Any) -> dict[str, Any]:
                captured.update(kwargs)
                return {"request_id": "AIR-x"}

            with patch.object(ao, "read_pending", return_value=[item]), \
                 patch.object(ao, "mark_consumed", side_effect=lambda *_a, **kw: consumed.append(kw["queue_item_id"])), \
                 patch.object(ao, "_find_projected_queue_request", return_value=None), \
                 patch("aria_kernel.agent_invocations.create_agent_invocation_request", fake_create), \
                 patch("aria_kernel.request_admission.admit_request",
                       return_value=type("A", (), {"admitted": True})()), \
                 patch("aria_kernel.tool_registry.append_tools_governance",
                       side_effect=lambda _b, kind, details, **_k: governance.append((kind, details))):
                ao._drain_next_cycle_queue(base_dir=root, daemon_agent_id="t", limit=1, workspace_root=workspace)
        return captured, governance, len(consumed)

    def test_the_fixed_shape_mints_the_stage_code_and_carries_the_ledger_as_data(self) -> None:
        captured, _governance, consumed = self._drain({
            "pressure_id": self.PRESSURE_ID, "reason": "funnel stalled at convergence: 50 arrived from f_finding, 0 left",
            "evidence": self.OWNERS, "provenance_refs": [_LEDGER_REF],
        }, committed=True)

        self.assertEqual(consumed, 1)
        self.assertEqual(captured["evidence_refs"], self.OWNERS)
        prompt = json.loads(captured["suggested_prompt"])
        self.assertEqual(prompt["provenance_refs"], [_LEDGER_REF])
        self.assertEqual(prompt["pressure_reason"], "funnel stalled at convergence: 50 arrived from f_finding, 0 left")
        self.assertEqual(prompt["refused_evidence_refs"], [])

    def test_a_stored_pre_fix_payload_never_reaches_the_evidence_channel(self) -> None:
        # The exact payload the four rejected requests were minted from.
        captured, governance, consumed = self._drain({
            "pressure_id": self.PRESSURE_ID, "reason": "funnel stalled", "evidence": [_LEDGER_REF],
        }, committed=True)

        self.assertEqual(captured, {}, "no request is minted on a ref no answer can cite")
        self.assertEqual(consumed, 1)
        [(kind, details)] = [row for row in governance if row[0].startswith("next_cycle_queue")]
        self.assertEqual(kind, "next_cycle_queue_item_unevidenced")
        self.assertEqual([entry["ref"] for entry in details["refused_evidence_refs"]], [_LEDGER_REF])
        self.assertIn("agent_evidence_ref_malformed", details["refused_evidence_refs"][0]["codes"])

    def test_an_unverifiable_host_keeps_the_item_pending(self) -> None:
        captured, governance, consumed = self._drain({
            "pressure_id": self.PRESSURE_ID, "reason": "funnel stalled",
            "evidence": self.OWNERS, "provenance_refs": [_LEDGER_REF],
        }, committed=False)

        self.assertEqual((captured, consumed), ({}, 0))
        self.assertEqual(
            [kind for kind, _ in governance if kind.startswith("next_cycle_queue")],
            ["next_cycle_queue_item_evidence_unverifiable"],
        )


if __name__ == "__main__":
    unittest.main()
