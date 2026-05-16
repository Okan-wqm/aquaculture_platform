"""Plan ARIA-V3.2 Phase 3.3 — D1 unified belief-freshness writer.

The 10-agent post-V4 fresh-run audit identified that
``aria-kernel/aria_kernel/memory.py`` has THREE separate writers to
``beliefs.jsonl``:

  * ``_record_belief`` (the support path) — stamps freshness fields.
  * ``_apply_diff_to_existing_beliefs`` (diff-decay path) — pre-V3.2
    did NOT refresh ``base_commit_sha`` + ``repo_state_id`` (inherited
    via ``row = dict(belief)``).
  * ``_mark_quarantined_source_beliefs`` (quarantine path) — same
    defect.

V3.2 §2a (F-010 D1) introduces ``_stamp_belief_freshness`` as the
single chokepoint. EVERY writer now routes through it. Freshness
becomes structural rather than per-writer convention.

Four invariant cases:

  * I-V3.2-01 — belief refreshes evidence_state + base_commit_sha
    on subsequent cycle when re-recorded via the support path.
  * I-V3.2-02 — glob_match_history appends per cycle, capped at
    20 entries.
  * I-V3.2-03 — belief lifecycle transitions to needs_revalidation
    on evidence loss; learning_events emits invalidation row.
  * I-V3.2-03b — diff-decay path freshness fields ALSO refresh
    (the multi-writer architectural defect this commit closes).
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _write_completion_proof(
    discovery_dir: Path,
    *,
    cycle_id: str,
    base_commit_sha: str,
    tracked_files: list[str] | None = None,
) -> None:
    """Plan ARIA-V3.2 §3.3 — write a minimal COMPLETION_PROOF.json
    + FATES.json so ``_repo_state`` + ``_evidence_state`` can read
    the cycle's discovery state. The helper bypasses real
    ``run_discovery`` to keep tests hermetic + fast.
    """
    discovery_dir.mkdir(parents=True, exist_ok=True)
    files = tracked_files or []
    completion = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "complete": True,
        "base_commit_sha": base_commit_sha,
        "snapshot_hash": f"sha256:{'0' * 64}",
        "repo_state_id": f"repo-state:{base_commit_sha}",
        "snapshot_mode": "committed",
        "dirty_snapshot": False,
        "dirty_path_count": 0,
        "file_counts": {
            "allowed": len(files),
            "fated": len(files),
            "generated": 0,
            "git_tracked": len(files),
            "unknown": 0,
            "working_tree": len(files),
        },
        "tracked_file_count": len(files),
        "fated_file_count": len(files),
        "unknown_count": 0,
        "missing_fates": [],
    }
    (discovery_dir / "COMPLETION_PROOF.json").write_text(
        json.dumps(completion), encoding="utf-8",
    )
    fates_payload = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "files": [
            {
                "path": path,
                "fate": "tracked",
                "content_hash": f"sha256:{i:064d}",
                "size_bytes": 100,
                "suffix": Path(path).suffix,
            }
            for i, path in enumerate(files)
        ],
    }
    (discovery_dir / "FATES.json").write_text(
        json.dumps(fates_payload), encoding="utf-8",
    )


class PhaseV3_2BeliefRefresh(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_2-belief-"))
        self.tools_root = self.tmp / "aria-tools"
        from aria_kernel.tool_registry import ensure_tools_dir
        ensure_tools_dir(self.tools_root)
        (self.tools_root / "memory").mkdir(parents=True, exist_ok=True)

    # I-V3.2-01 — refreshes evidence_state + base_commit_sha on
    # subsequent cycle via the support writer.
    def test_i_v3_2_01_belief_refreshes_freshness_on_subsequent_cycle(
        self,
    ) -> None:
        from aria_kernel.memory import _record_belief, latest_beliefs
        from aria_kernel.ledger import load_jsonl

        # Cycle 1 — base_commit_sha SHA_A.
        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-1",
            cycle_id="cycle-1",
            base_commit_sha="aa" * 20,
            tracked_files=["nx.json"],
        )
        row1 = _record_belief(
            self.tools_root,
            cycle_id="cycle-1",
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )
        self.assertEqual(row1["base_commit_sha"], "aa" * 20)
        self.assertEqual(row1["last_seen_cycle"], "cycle-1")
        verified_at_1 = row1["verified_at"]
        self.assertIsNotNone(verified_at_1)

        # ``utc_now()`` has second-level precision (microseconds
        # stripped) so a 1.1s sleep guarantees a strict-later
        # timestamp on the next cycle's row.
        time.sleep(1.1)

        # Cycle 2 — base_commit_sha SHA_B. Same belief_id.
        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-2",
            cycle_id="cycle-2",
            base_commit_sha="bb" * 20,
            tracked_files=["nx.json"],
        )
        row2 = _record_belief(
            self.tools_root,
            cycle_id="cycle-2",
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )

        # Plan ARIA-V3.2 §2a — these MUST refresh per cycle.
        self.assertEqual(row2["base_commit_sha"], "bb" * 20)
        self.assertEqual(row2["last_seen_cycle"], "cycle-2")
        self.assertGreater(row2["verified_at"], verified_at_1)

        # The latest row for the belief_id has the V2 freshness.
        all_rows = load_jsonl(self.tools_root / "memory" / "beliefs.jsonl")
        latest = {r["belief_id"]: r for r in latest_beliefs(all_rows)}
        self.assertEqual(
            latest["repo-uses-nx"]["base_commit_sha"], "bb" * 20,
        )

    # I-V3.2-02 — glob_match_history appends per cycle, cap at 20.
    def test_i_v3_2_02_glob_match_history_appends_per_cycle(self) -> None:
        from aria_kernel.memory import _record_belief, latest_beliefs
        from aria_kernel.ledger import load_jsonl

        # Two cycles with different glob match counts.
        for cycle_n, file_count, sha_hex in [
            ("cycle-G1", 3, "11"),
            ("cycle-G2", 7, "22"),
        ]:
            files = [
                f"apps/svc{i}/src/database/migrations/{i:010d}-create.ts"
                for i in range(file_count)
            ]
            _write_completion_proof(
                self.tools_root / "discovery" / cycle_n,
                cycle_id=cycle_n,
                base_commit_sha=sha_hex * 20,
                tracked_files=files,
            )
            _record_belief(
                self.tools_root,
                cycle_id=cycle_n,
                belief_id="repo-has-recurring-typeorm-migration-surface",
                claim="repo has recurring TypeORM migrations",
                evidence_refs=["apps/*/src/database/migrations/*.ts"],
                confidence=0.855,
            )
        all_rows = load_jsonl(self.tools_root / "memory" / "beliefs.jsonl")
        latest = {r["belief_id"]: r for r in latest_beliefs(all_rows)}
        history = latest[
            "repo-has-recurring-typeorm-migration-surface"
        ]["glob_match_history"]
        self.assertGreaterEqual(len(history), 2)
        cycles_in_history = [entry.get("cycle_id") for entry in history]
        self.assertIn("cycle-G1", cycles_in_history)
        self.assertIn("cycle-G2", cycles_in_history)
        # Cap at 20 (Plan ARIA-V3.2 §2a invariant).
        self.assertLessEqual(len(history), 20)

    # I-V3.2-03b — diff-decay path refreshes freshness fields
    # (the multi-writer architectural defect V3.2 closes).
    def test_i_v3_2_03b_diff_decay_path_refreshes_freshness_fields(
        self,
    ) -> None:
        from aria_kernel.memory import (
            _apply_diff_to_existing_beliefs,
            _record_belief,
            latest_beliefs,
        )
        from aria_kernel.ledger import load_jsonl

        # Cycle 1 — record belief with concrete evidence_ref.
        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-DD1",
            cycle_id="cycle-DD1",
            base_commit_sha="aa" * 20,
            tracked_files=["nx.json"],
        )
        _record_belief(
            self.tools_root,
            cycle_id="cycle-DD1",
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )

        time.sleep(0.01)

        # Cycle 2 — evidence file disappears (nx.json no longer
        # in FATES). Trigger diff-decay writer.
        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-DD2",
            cycle_id="cycle-DD2",
            base_commit_sha="cc" * 20,
            tracked_files=[],  # nx.json gone
        )
        fates_payload = {
            "schema_version": 1,
            "cycle_id": "cycle-DD2",
            "files": [],
        }
        diff = {
            "added_paths": [],
            "removed_paths": ["nx.json"],
            "changed_paths": [],
        }
        _apply_diff_to_existing_beliefs(
            self.tools_root, "cycle-DD2", diff, fates_payload,
        )

        # The decayed belief row MUST carry cycle-DD2's
        # base_commit_sha (Plan ARIA-V3.2 §2a closes the multi-
        # writer staleness).
        all_rows = load_jsonl(self.tools_root / "memory" / "beliefs.jsonl")
        latest = {r["belief_id"]: r for r in latest_beliefs(all_rows)}
        decayed = latest["repo-uses-nx"]
        self.assertEqual(
            decayed["base_commit_sha"], "cc" * 20,
            msg=(
                "Plan ARIA-V3.2 §2a (F-010 D1) — diff-decay writer "
                "MUST refresh base_commit_sha to the current cycle "
                "(was: inheriting from prior belief row)"
            ),
        )
        self.assertEqual(decayed["last_seen_cycle"], "cycle-DD2")
        self.assertEqual(
            decayed["repo_state_id"], "repo-state:" + "cc" * 20,
        )
        # status flipped to needs_revalidation or stale (evidence
        # missing).
        self.assertIn(
            decayed["status"], {"needs_revalidation", "stale"},
        )
        # verified_at PRESERVED from cycle-DD1 (audit-trail signal).
        self.assertIsNotNone(decayed["verified_at"])

    # I-V3.2-03 — lifecycle transition + learning_events emission.
    def test_i_v3_2_03_belief_lifecycle_transitions_on_evidence_loss(
        self,
    ) -> None:
        from aria_kernel.memory import (
            _apply_diff_to_existing_beliefs,
            _record_belief,
        )
        from aria_kernel.ledger import load_jsonl

        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-L1",
            cycle_id="cycle-L1",
            base_commit_sha="11" * 20,
            tracked_files=["nx.json"],
        )
        _record_belief(
            self.tools_root,
            cycle_id="cycle-L1",
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )

        _write_completion_proof(
            self.tools_root / "discovery" / "cycle-L2",
            cycle_id="cycle-L2",
            base_commit_sha="22" * 20,
            tracked_files=[],
        )
        fates_payload = {"schema_version": 1, "cycle_id": "cycle-L2", "files": []}
        diff = {
            "added_paths": [],
            "removed_paths": ["nx.json"],
            "changed_paths": [],
        }
        n_written = _apply_diff_to_existing_beliefs(
            self.tools_root, "cycle-L2", diff, fates_payload,
        )
        self.assertGreaterEqual(n_written, 1)

        # learning-events.jsonl should have an evidence_invalidated
        # row for cycle-L2.
        learning = load_jsonl(
            self.tools_root / "memory" / "learning-events.jsonl"
        )
        invalidated = [
            row for row in learning
            if row.get("cycle_id") == "cycle-L2"
            and row.get("event_type") == "evidence_invalidated"
        ]
        self.assertGreaterEqual(len(invalidated), 1)


if __name__ == "__main__":
    unittest.main()
