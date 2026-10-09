"""The memory-laws finding (B1a) — the writer holds ARIA's memory append-only.

Measured on the state branch tip 05c5d3160 (2026-10-02): compaction had moved
662 of the 700 memory rows ARIA ever recorded into archives no memory reader
opened (350 beliefs -> 8 live, 350 learning events -> 33); the manual resets
01f37e939 (beliefs 212 rows, observations 30) and f5bcb194d (learning events,
runs) emptied ledgers outright; and the next kernel publish
(executor-33604693287-1, 2026-09-02) continued a tip claiming 212 belief rows
with zero. ARIA-HIGH-263 closed the publish and snapshot ends. WHAT IS PINNED
HERE is the two halves that landed on top of it:

- the memory set is the manifest's ``memory`` flag, and it now covers the
  whole self-learning record — judgment, calibration, evals, fitness,
  genesis, change and invocation ledgers — not only ``memory/*``; every
  member is a declared tools-root ledger, and the two surfaces tests fake
  legacy rows in by rewriting history stay out;
- the single rewrite writer (``ledger._rewrite_jsonl_unlocked``) refuses a
  rewrite of a memory ledger that drops or changes a recorded row
  (``memory_history_rewrite_refused``) before a byte is written, while
  appends, a byte-idempotent restamp and the chain backfill of an unchained
  legacy file pass;
- monthly segment appends to a memory ledger (agent-invocation prompts,
  ARIA-HIGH-275) never reach the rewrite path, so rollover is untouched.

The archive reader and the repo-shaped index (``memory_history``,
``memory_loci``) are the B1b half of the same finding and live elsewhere.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aria_kernel.ledger import (
    LedgerIntegrityError,
    append_declared_jsonl,
    load_declared_jsonl,
    rewrite_declared_jsonl,
    rewrite_jsonl,
)
from aria_kernel.state_manifest import memory_surfaces, surface_by_name
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

BELIEFS = "memory_beliefs"
LEARNING = "memory_learning_events"
PROMPTS = "agent_invocation_prompts"

# The self-learning ledgers the memory flag gained in this change (the 2026
# -10-10 memory-laws finding): every one is a tools-root ledger whose rows
# ARIA or its agents recorded about their own work. tools_governance and
# agent_invocation_requests are deliberately absent — tests fake legacy
# rows in them by rewriting history (test_compaction_attestation,
# test_state_publish_maintenance, test_judgment_bridge_e2e,
# test_agent_submit_result_e2e).
SELF_LEARNING_MEMORY = {
    "judgment_samples",
    "operator_feedback",
    "feedback_consensus_uncertainties",
    "calibration_judge",
    "calibration_adapter_reports",
    "calibration_recommendations",
    "goldset_proposals",
    "agent_evals",
    "agent_eval_fixtures",
    "fitness_reports",
    "fitness_agent",
    "skill_genesis_requests",
    "skill_genesis_drafts",
    "skill_genesis_sandbox",
    "skill_genesis_materializations",
    "agent_genesis_requests",
    "agent_genesis_drafts",
    "agent_genesis_pr_lanes",
    "agent_genesis_materializations",
    "agent_genesis_extension_decisions",
    "genesis_sandbox_runs",
    "genesis_lifecycle_events",
    "plan_convergence_events",
    "change_planned",
    "change_committed",
    "change_validated",
    "change_outcome",
    "agent_invocation_claims",
    "agent_invocation_results",
    "agent_invocation_transcripts",
    "agent_invocation_contexts",
    "agent_invocation_prompts",
}


def _ts(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _belief(belief_id: str, days_ago: float, status: str = "supported") -> dict[str, Any]:
    return {
        "schema_version": 2,
        "belief_id": belief_id,
        "claim": f"claim about {belief_id}",
        "status": status,
        "confidence": 0.9,
        "evidence_refs": ["apps/hr-service/src/**/*.ts"],
        "recorded_at": _ts(days_ago),
        "cycle_id": f"cyc-{days_ago}",
    }


def _event(belief_id: str, days_ago: float, event_type: str = "belief_confirmed") -> dict[str, Any]:
    return {
        "schema_version": 1,
        "recorded_at": _ts(days_ago),
        "cycle_id": f"cyc-{days_ago}",
        "event_type": event_type,
        "target_type": "belief",
        "target_id": belief_id,
        "repo_state_id": None,
        "base_commit_sha": None,
        "evidence_hashes": [],
        "details": {},
    }


def _sha(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _prompt_row(request_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "row_type": "prompt",
        "row_id": f"prompt:{request_id}",
        "request_id": request_id,
        "context_hash": "sha256:" + "c" * 64,
        "prompt_hash": "sha256:" + request_id.encode().hex().ljust(64, "0")[:64],
        "prompt_text": f"prompt for {request_id}",
    }


class MemoryStoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-memory-laws-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.beliefs = self.tools / "memory" / "beliefs.jsonl"
        self.learning = self.tools / "memory" / "learning-events.jsonl"

    def _append(self, path: Path, surface: str, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            append_declared_jsonl(path, row, expected_surface=surface)


class MemoryRewriteRefused(MemoryStoreTestCase):
    def test_the_writer_refuses_to_drop_or_edit_a_recorded_memory_row_and_admits_appends(self) -> None:
        self._append(self.beliefs, BELIEFS, [_belief("b-0", 3), _belief("b-1", 2), _belief("b-2", 1)])
        self._append(self.learning, LEARNING, [_event("b-0", 3)])
        rows = load_declared_jsonl(self.beliefs, expected_surface=BELIEFS)
        before = _sha(self.beliefs)

        with self.assertRaises(LedgerIntegrityError) as dropped:
            rewrite_declared_jsonl(self.beliefs, rows[1:], expected_surface=BELIEFS, migration_id="collapse")
        self.assertIn("memory_history_rewrite_refused", str(dropped.exception))
        self.assertIn("would drop 1 of 3", str(dropped.exception))

        edited = [dict(row) for row in rows]
        edited[0]["status"] = "withdrawn"
        with self.assertRaises(LedgerIntegrityError) as changed:
            rewrite_declared_jsonl(self.beliefs, edited, expected_surface=BELIEFS, migration_id="edit")
        self.assertIn("memory_history_rewrite_refused", str(changed.exception))
        self.assertIn("row 0", str(changed.exception))

        self.assertEqual(_sha(self.beliefs), before, "a refused rewrite writes nothing")

        # The admitted shapes: appending (rows keep their position and get
        # their old hashes again), and the same rows rewritten once more.
        hashes = [row["ledger_hash"] for row in rows]
        rewrite_declared_jsonl(
            self.beliefs, rows + [_belief("b-3", 0)],
            expected_surface=BELIEFS, migration_id="restamp-and-append",
        )
        after = load_declared_jsonl(self.beliefs, expected_surface=BELIEFS)
        self.assertEqual([row["ledger_hash"] for row in after[: len(rows)]], hashes)
        self.assertEqual(len(after), len(rows) + 1)

    def test_a_memory_rewrite_is_refused_on_every_memory_surface(self) -> None:
        """The law is the manifest flag, not a memory/* special case: the
        self-learning ledgers the finding added are protected the moment
        they hold rows."""
        path = self.tools / "judgment-samples.jsonl"
        append_declared_fixture(path, {"schema_version": 1, "sample": "s-0"}, expected_surface="judgment_samples")
        rows = load_declared_jsonl(path, expected_surface="judgment_samples")
        with self.assertRaises(LedgerIntegrityError) as refused:
            rewrite_declared_jsonl(path, [], expected_surface="judgment_samples", migration_id="empty")
        self.assertIn("memory_history_rewrite_refused", str(refused.exception))
        self.assertIn("judgment_samples", str(refused.exception))
        self.assertEqual(len(load_declared_jsonl(path, expected_surface="judgment_samples")), len(rows))

    def test_the_chain_backfill_of_an_unchained_legacy_memory_file_passes(self) -> None:
        """What ``_backfill`` does to a memory ledger that predates the hash
        chain: strip the (absent) chain fields and re-chain from scratch. No
        recorded row changes, so the law admits it."""
        rows = [_belief("b-0", 9), _belief("b-1", 8), _belief("b-2", 7)]
        self.beliefs.parent.mkdir(parents=True, exist_ok=True)
        self.beliefs.write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8"
        )

        rewrite_jsonl(
            self.beliefs, rows,
            allow_legacy=True,
            legacy_reason="operator_acknowledged_hash_chain_backfill",
            expires_at="2026-12-31T00:00:00+00:00",
        )

        chained = load_declared_jsonl(self.beliefs, expected_surface=BELIEFS)
        self.assertEqual(len(chained), 3)
        self.assertIsNone(chained[0]["previous_ledger_hash"])
        self.assertTrue(all(row["previous_ledger_hash"] for row in chained[1:]))
        self.assertTrue(all(row["ledger_hash"] for row in chained))
        self.assertEqual(
            [{k: v for k, v in row.items() if k not in ("ledger_hash", "previous_ledger_hash")}
             for row in chained],
            rows,
            "the backfill re-chains; it never edits content",
        )


class MemorySurfaceSet(unittest.TestCase):
    def test_every_memory_surface_is_a_declared_tools_ledger(self) -> None:
        surfaces = memory_surfaces()
        self.assertTrue(surfaces)
        for surface in surfaces:
            self.assertEqual(surface.state_class, "ledger", surface.name)
            self.assertEqual(surface.root_kind, "tools", surface.name)
            self.assertIs(surface_by_name(surface.name), surface)

    def test_the_self_learning_record_is_memory_and_the_two_exceptions_stay_out(self) -> None:
        names = {surface.name for surface in memory_surfaces()}
        self.assertTrue(SELF_LEARNING_MEMORY <= names, sorted(SELF_LEARNING_MEMORY - names))
        # The arbiter's ruled minimum (tests/test_memory_not_compactable.py) too.
        self.assertTrue(
            {
                "memory_beliefs", "memory_learning_events", "memory_observations",
                "memory_uncertainties", "memory_contradictions", "memory_calibration",
                "reflections", "kg_conventions", "kg_anti_patterns",
                "kg_pressure_source_effectiveness", "kg_duel_ratings", "kg_embeddings",
            } <= names
        )
        # Load-bearing exclusions: tests fake legacy rows in these two by
        # rewriting history, so the writer's law cannot cover them yet.
        self.assertNotIn("tools_governance", names)
        self.assertNotIn("agent_invocation_requests", names)


class SegmentAppendsAreNotRewrites(MemoryStoreTestCase):
    def test_monthly_prompts_segments_append_past_the_memory_law(self) -> None:
        """agent_invocation_prompts is memory AND segmented (ARIA-HIGH-275).
        Rollover appends to a fresh monthly segment — it never rewrites, so
        the memory law must not fire; emptying the frozen segment must."""
        from aria_kernel import ledger

        frozen = self.tools / "agent-invocations" / "prompts.jsonl"
        append_declared_fixture(frozen, _prompt_row("AIR-0"), expected_surface=PROMPTS)
        frozen_bytes = frozen.read_bytes()

        ledger.append_segment_rows(
            self.tools, [_prompt_row("AIR-1")], expected_surface=PROMPTS, bypass_profile_gate=True,
        )

        self.assertEqual(frozen.read_bytes(), frozen_bytes, "segment zero is frozen")
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        segment = load_declared_jsonl(
            self.tools / "agent-invocations" / "prompts" / f"{month}.jsonl", expected_surface=PROMPTS
        )
        self.assertEqual([row["request_id"] for row in segment if row.get("row_type") == "prompt"], ["AIR-1"])

        rows = load_declared_jsonl(frozen, expected_surface=PROMPTS)
        with self.assertRaises(LedgerIntegrityError) as refused:
            rewrite_declared_jsonl(frozen, rows[:0], expected_surface=PROMPTS, migration_id="empty")
        self.assertIn("memory_history_rewrite_refused", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
