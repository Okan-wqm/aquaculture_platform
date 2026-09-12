"""C9/E8 — a blocked task candidate must NOT become a persistent mission.

Live proof of the defect: all three `shadow_run_summary` missions standing on
the store originated from task candidates carrying
`blocked_by=["operator_feedback_required"]`. `adopt_task_candidates` read the
candidate's `source`/`source_id` but never its `blocked_by`, so it opened a
mission for work that cannot run — and a mission mints an agent request. The
pressure path already refuses a blocked item (reflection.py: "A blocked
pressure is operator-facing work, not schedulable work"); the mission path had
re-opened the same door. This pins the guard so it cannot regress: a blocked
candidate is REFUSED and recorded, never adopted; an identical-but-unblocked
candidate still adopts.

THE FIXTURES CARRY `recommended_action` (ORPHAN-MEDIUM-730). `pressure._pressure`
REQUIRES that field, so every pressure the producer emits has one — and since
the mission's closure contract is now read off the candidate's `next_action`,
which `task._candidate_from_pressure` takes from exactly that field, a fixture
without it exercises a shape the pipeline never produces and would be testing
the blocked-guard against a candidate that is refused for a different reason.
The refusal for a pressure that names no action has its own pin below.

THE LIVE SHAPE (origin/aria/state, read 2026-09-12). `tasks/task-candidates.
jsonl` for cyc-20260904T194353Z-auto: ten slots, of which two ``capability_
gap shadow_run:*`` gaps at 90 and three ``shadow_run_summary`` rows at 75 carry
``blocked_by=["genesis_adjudication_required"]`` — five slots the adopter
refused on sight (five ``candidate_blocked`` rows that night; six on
2026-08-21, when a third gap was in the slots). Across the 71 rows since
2026-08-13, joined to the payloads on (cycle_id, source, source_id): 43 carry
``genesis_adjudication_required``, 15 the pre-Y8 ``operator_feedback_required``
(operator-owned), 13 predate the first stored payload. The limit cut the
ranked list BEFORE the adopter looked at ``blocked_by``, so an admissible
candidate ranked past the tenth slot never reached it.
`BlockedCandidatesDoNotSpendTheBudget` replays the 09-04 shape from fixture
rows and pins the partition: panel-owned candidates are ROUTED OUT at the
generator (no refusal row — nothing was refused), operator-owned ones are
disclosed outside the budget. `TheRefusalNamesItsOwner` pins that a refusal
row says who clears the block, and `ARefusalIsDisclosedOncePerClaim` that
the same standing block is one row across nights, not one row a night.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.candidate_blocks import GENESIS_ADJUDICATION_REQUIRED, OWNER_AGENT_PANEL, OWNER_OPERATOR
from aria_kernel.ledger import append_declared_jsonl, load_jsonl
from aria_kernel.mission import adopt_task_candidates, list_open_missions
from aria_kernel.task import generate_task_candidates
from aria_kernel.tool_registry import ensure_tools_dir

REPO_HASH = "repohash0001"


def _shadow_run_gap(tool_id: str, raw_count: int) -> dict:
    """A ``shadow_run:<tool>`` capability gap shaped like
    `capability_gap._gaps_from_shadow_runs` mints it (live rows 2026-09-04)."""
    return {
        "schema_version": 1,
        "gap_id": f"gap-{tool_id[:8]}",
        "cycle_id": "cyc-prev",
        "gap_type": "agent_gap",
        "source_id": tool_id,
        "capability_gap_key": f"shadow_run:{tool_id}",
        "primary_source": "shadow-run",
        "source_types": ["shadow-run"],
        "title": f"Triage recurring SHADOW output from {tool_id}",
        "evidence_refs": ["apps/farm-service/src/app.module.ts"],
        "related_existing_agents": [],
        "recommended_action": "draft_new_aria_agent",
        "candidate_validation_commands": [],
        "score": min(90, 45 + raw_count),
        "blocked_by": [GENESIS_ADJUDICATION_REQUIRED],
    }


class _StoreFixture(unittest.TestCase):
    """One temp store per test; the helpers write the shapes the producers write."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = ensure_tools_dir(self.base)

    def _write_pressures(self, cycle_id: str, pressures: list[dict]) -> None:
        pdir = self.root / "pressure"
        pdir.mkdir(parents=True, exist_ok=True)
        (pdir / f"{cycle_id}.json").write_text(
            json.dumps({"schema_version": 1, "pressures": pressures})
        )

    def _write_gaps(self, gaps: list[dict]) -> None:
        append_declared_jsonl(
            self.root / "capability-gaps" / "gaps.jsonl",
            {"schema_version": 1, "cycle_id": "cyc-prev", "gap_count": len(gaps), "gaps": gaps},
            expected_surface="capability_gaps",
        )

    def _refusals(self) -> list[dict]:
        return [
            row.get("details", {})
            for row in load_jsonl(self.root / "governance.jsonl")
            if row.get("kind") == "mission_candidate_refused"
        ]


class AdoptBlockedGuardTests(_StoreFixture):
    def test_blocked_candidate_is_refused_not_adopted(self) -> None:
        cycle_id = "cyc-2026-08-12"
        self._write_pressures(
            cycle_id,
            [
                {
                    "pressure_id": "pe-blocked",
                    "score": 90,
                    "reason": "needs operator",
                    "recommended_action": "ask the operator to release the hold",
                    "blocked_by": ["operator_feedback_required"],
                },
                {
                    "pressure_id": "pe-open",
                    "score": 80,
                    "reason": "schedulable",
                    "recommended_action": "rerun discovery and inspect missing fates",
                    "blocked_by": [],
                },
            ],
        )
        result = adopt_task_candidates(
            cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
        )
        # The blocked candidate is refused; only the unblocked one adopts.
        self.assertEqual(result["adopted"], 1)
        self.assertGreaterEqual(result["refused"], 1)

        # No mission exists for the blocked source_id.
        open_ids = {m.get("source_id") for m in list_open_missions(base_dir=self.base)}
        self.assertIn("pe-open", open_ids)
        self.assertNotIn("pe-blocked", open_ids)

        # The refusal is RECORDED, never dropped in silence.
        reasons = [
            row.get("details", {}).get("reason")
            for row in load_jsonl(self.root / "governance.jsonl")
            if row.get("kind") == "mission_candidate_refused"
        ]
        self.assertIn("candidate_blocked", reasons)

    def test_unblocked_candidate_still_adopts(self) -> None:
        cycle_id = "cyc-2026-08-12b"
        self._write_pressures(
            cycle_id,
            [{
                "pressure_id": "pe-solo",
                "score": 70,
                "reason": "go",
                "recommended_action": "rerun discovery and inspect missing fates",
                "blocked_by": [],
            }],
        )
        result = adopt_task_candidates(
            cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
        )
        self.assertEqual(result["adopted"], 1)
        # The mission's forward pointer is the PRESSURE's own recommendation,
        # not a restatement of its reason — the two are different strings in
        # this fixture precisely so the difference is observable.
        mission = list_open_missions(base_dir=self.base)[0]
        self.assertEqual(
            mission["next_action"], "rerun discovery and inspect missing fates"
        )

    def test_a_pressure_that_recommends_nothing_is_refused_not_minted(self) -> None:
        """The blocked guard's sibling (ORPHAN-MEDIUM-730).

        `_pressure` requires `recommended_action`, so this is a legacy or
        hand-written row — and a mission opened from it would have to invent
        its own instruction or restate the problem as one. It is refused and
        disclosed, exactly like a blocked candidate.
        """
        cycle_id = "cyc-2026-08-19"
        self._write_pressures(
            cycle_id,
            [{"pressure_id": "pe-mute", "score": 70, "reason": "something is wrong",
              "blocked_by": []}],
        )

        result = adopt_task_candidates(
            cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
        )

        self.assertEqual(result["adopted"], 0)
        self.assertEqual(list_open_missions(base_dir=self.base), [])
        reasons = [
            row.get("details", {}).get("reason")
            for row in load_jsonl(self.root / "governance.jsonl")
            if row.get("kind") == "mission_candidate_refused"
        ]
        self.assertEqual(reasons, ["no_derivable_next_action"])


class BlockedCandidatesDoNotSpendTheBudget(_StoreFixture):
    def _live_shape(self, cycle_id: str) -> None:
        """Three panel-routed gaps at 90 (the live shadow_run:* rows) above
        eight admissible pressures at 50-57: eleven candidates for ten slots."""
        self._write_gaps([
            _shadow_run_gap("test-gap-adapter", 279),
            _shadow_run_gap("doc-staleness-adapter", 1673),
            _shadow_run_gap("tenant-scoping-adapter", 66),
        ])
        self._write_pressures(cycle_id, [
            {
                "pressure_id": f"pressure:own-pr-ci:pr-{1300 + n}",
                "score": 50 + n,
                "reason": f"own PR {1300 + n} is red",
                "recommended_action": f"read the failing check's log for PR {1300 + n} and fix forward",
                "blocked_by": [],
            }
            for n in range(8)
        ])

    def test_the_generator_partitions_before_it_cuts(self) -> None:
        cycle_id = "cyc-20260904T194353Z-auto"
        self._live_shape(cycle_id)

        payload = generate_task_candidates(cycle_id=cycle_id, base_dir=self.base, limit=10)

        self.assertEqual(payload["schema_version"], 2)
        # Every admissible candidate is inside the budget; no task is blocked.
        self.assertEqual(payload["task_count"], 8)
        self.assertEqual([t["blocked_by"] for t in payload["tasks"]], [[]] * 8)
        # The panel-owned ones are disclosed as ROUTED, outside the budget,
        # with their owner — and nothing sits in the operator's partition.
        self.assertEqual(payload["routed_to_panel_count"], 3)
        self.assertEqual(
            {t["source_id"] for t in payload["routed_to_panel"]},
            {"shadow_run:test-gap-adapter", "shadow_run:doc-staleness-adapter", "shadow_run:tenant-scoping-adapter"},
        )
        self.assertEqual({t["block"]["owner"] for t in payload["routed_to_panel"]}, {OWNER_AGENT_PANEL})
        self.assertEqual((payload["blocked_count"], payload["blocked"]), (0, []))

    def test_an_operator_block_lands_in_the_blocked_partition_not_the_panel_one(self) -> None:
        cycle_id = "cyc-2026-09-12c"
        self._write_pressures(cycle_id, [{
            "pressure_id": "pe-unbound", "score": 90, "reason": "tool left the registry",
            "recommended_action": "rerun the schema drift adapter",
            "blocked_by": ["candidate_tool_unregistered:typeorm-entity-schema-adapter"],
        }])

        payload = generate_task_candidates(cycle_id=cycle_id, base_dir=self.base)

        self.assertEqual(payload["routed_to_panel"], [])
        self.assertEqual([t["source_id"] for t in payload["blocked"]], ["pe-unbound"])
        self.assertEqual(payload["blocked"][0]["block"]["owner"], OWNER_OPERATOR)

    def test_every_admissible_candidate_is_adopted_when_blocked_ones_outrank_it(self) -> None:
        """Pre-partition the top-10 cut kept the three blocked gaps and dropped
        the lowest admissible pressure: seven adopted, one never offered. Now
        eight adopt, the three gaps go to the panel, and NO refusal row is
        written for them — the adopter never saw them."""
        cycle_id = "cyc-20260904T194353Z-auto"
        self._live_shape(cycle_id)

        result = adopt_task_candidates(cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base)

        self.assertEqual(result["adopted"], 8)
        self.assertEqual(result["refused"], 0)
        self.assertEqual(result["refusals_disclosed"], 0)
        self.assertEqual(result["routed_to_panel"], 3)
        self.assertEqual(result["blocked_by_owner"], {})
        self.assertEqual(self._refusals(), [])
        open_ids = {m["source_id"] for m in list_open_missions(base_dir=self.base)}
        self.assertIn("pressure:own-pr-ci:pr-1300", open_ids)
        self.assertNotIn("shadow_run:test-gap-adapter", open_ids)

    def test_the_live_shape_writes_no_refusal_row_on_any_night(self) -> None:
        """The 09-04 shape, two nights running: v1 wrote five rows a night."""
        for cycle_id in ("cyc-20260904T093220Z-auto", "cyc-20260904T194353Z-auto"):
            self._live_shape(cycle_id)
            adopt_task_candidates(cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base)

        self.assertEqual(self._refusals(), [])

    def test_a_shadow_run_no_longer_mints_a_task_candidate_of_its_own(self) -> None:
        """The retired producer: a shadow run with raw findings and nothing
        emitted used to add a ``shadow_run_summary`` candidate blocked by a
        constant. The gap path carries the same run to the panel; the summary
        path carried it nowhere."""
        from aria_kernel.tool_health import runs_path

        cycle_id = "cyc-shadow"
        append_declared_jsonl(
            runs_path(self.root),
            {
                "schema_version": 1,
                "run_id": "run-shadow",
                "tool_id": "tenant-scoping-adapter",
                "cycle_id": cycle_id,
                "status": "ok",
                "read_paths": ["apps/farm-service/src/app.module.ts"],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 66},
            },
            expected_surface="runs",
        )

        payload = generate_task_candidates(cycle_id=cycle_id, base_dir=self.base)

        every_partition = [*payload["tasks"], *payload["blocked"], *payload["routed_to_panel"]]
        self.assertNotIn("shadow_run_summary", {t["source"] for t in every_partition})


class TheRefusalNamesItsOwner(_StoreFixture):
    def test_a_panel_routed_gap_is_never_refused_it_is_routed(self) -> None:
        cycle_id = "cyc-20260904T194353Z-auto"
        self._write_gaps([_shadow_run_gap("doc-staleness-adapter", 1673)])

        result = adopt_task_candidates(cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base)

        self.assertEqual(self._refusals(), [])
        self.assertEqual(result["routed_to_panel"], 1)
        [routed] = load_jsonl(self.root / "tasks" / "task-candidates.jsonl")[-1]["routed_to_panel"]
        self.assertEqual(routed["source_id"], "shadow_run:doc-staleness-adapter")
        self.assertEqual(routed["block"]["blocked_by"], [GENESIS_ADJUDICATION_REQUIRED])
        self.assertEqual(routed["block"]["owner"], OWNER_AGENT_PANEL)
        self.assertIn("none: the genesis panel adjudicates", routed["block"]["operator_action"])

    def test_an_operator_block_is_refused_with_the_operator_named(self) -> None:
        cycle_id = "cyc-2026-09-12"
        self._write_pressures(cycle_id, [{
            "pressure_id": "pe-unbound",
            "score": 90,
            "reason": "the pressure names a tool that left the registry",
            "recommended_action": "rerun the schema drift adapter",
            "blocked_by": ["candidate_tool_unregistered:typeorm-entity-schema-adapter"],
        }])

        adopt_task_candidates(cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base)

        [refusal] = self._refusals()
        self.assertEqual(refusal["schema_version"], 2)
        self.assertEqual(refusal["reason"], "candidate_blocked")
        self.assertEqual(refusal["blocked_by"], ["candidate_tool_unregistered:typeorm-entity-schema-adapter"])
        self.assertEqual(refusal["owner"], OWNER_OPERATOR)
        self.assertIn("register the named tool", refusal["operator_action"])
        self.assertEqual(refusal["unregistered_block_tokens"], [])

    def test_an_unregistered_token_is_disclosed_on_the_refusal(self) -> None:
        cycle_id = "cyc-2026-09-12b"
        self._write_pressures(cycle_id, [{
            "pressure_id": "pe-novel",
            "score": 90,
            "reason": "blocked by a token nobody registered",
            "recommended_action": "do the thing",
            "blocked_by": ["novel_gate_required"],
        }])

        adopt_task_candidates(cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base)

        [refusal] = self._refusals()
        self.assertEqual(refusal["owner"], OWNER_OPERATOR)
        self.assertEqual(refusal["unregistered_block_tokens"], ["novel_gate_required"])
        self.assertIn("candidate_blocks.py", refusal["operator_action"])


class ARefusalIsDisclosedOncePerClaim(_StoreFixture):
    """The same operator block, night after night, is ONE row — and a
    changed block is a new row. v1 wrote one row per candidate per night."""

    def _pressure(self, cycle_id: str, blocked_by: list[str]) -> None:
        self._write_pressures(cycle_id, [{
            "pressure_id": "pe-unbound", "score": 90,
            "reason": "the pressure names a tool that left the registry",
            "recommended_action": "rerun the schema drift adapter",
            "blocked_by": blocked_by,
        }])

    def test_the_same_block_on_three_nights_is_one_row(self) -> None:
        results = []
        for night in ("cyc-n1", "cyc-n2", "cyc-n3"):
            self._pressure(night, ["candidate_tool_unregistered:typeorm-entity-schema-adapter"])
            results.append(adopt_task_candidates(cycle_id=night, repo_hash=REPO_HASH, base_dir=self.base))

        self.assertEqual([r["refused"] for r in results], [1, 1, 1])
        self.assertEqual([r["refusals_disclosed"] for r in results], [1, 0, 0])
        [refusal] = self._refusals()
        self.assertEqual(refusal["cycle_id"], "cyc-n1")

    def test_a_changed_block_is_a_new_row(self) -> None:
        self._pressure("cyc-n1", ["candidate_tool_unregistered:typeorm-entity-schema-adapter"])
        adopt_task_candidates(cycle_id="cyc-n1", repo_hash=REPO_HASH, base_dir=self.base)
        self._pressure("cyc-n2", ["manifest_required"])

        result = adopt_task_candidates(cycle_id="cyc-n2", repo_hash=REPO_HASH, base_dir=self.base)

        self.assertEqual(result["refusals_disclosed"], 1)
        self.assertEqual([r["blocked_by"] for r in self._refusals()],
                         [["candidate_tool_unregistered:typeorm-entity-schema-adapter"], ["manifest_required"]])

    def test_a_non_block_refusal_is_also_once_per_claim(self) -> None:
        for night in ("cyc-n1", "cyc-n2"):
            self._write_pressures(night, [{"pressure_id": "pe-mute", "score": 70,
                                           "reason": "something is wrong", "blocked_by": []}])
            adopt_task_candidates(cycle_id=night, repo_hash=REPO_HASH, base_dir=self.base)

        self.assertEqual([r["reason"] for r in self._refusals()], ["no_derivable_next_action"])


if __name__ == "__main__":
    unittest.main()
