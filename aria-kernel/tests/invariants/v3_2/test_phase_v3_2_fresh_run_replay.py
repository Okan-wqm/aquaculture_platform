"""Plan ARIA-V3.2 Phase 3.4 — holistic fresh-run replay invariant.

The 10-agent post-V4 fresh-run audit identified the operator's
replay scenario: wipe ``aria-tools/``, run
``aria-kernel autonomy run --max-cycles 1``, verify the daily
report shows correct counts AND beliefs carry current SHA AND
dirty-tree event carries cycle_id.

This invariant replicates the audit scenario in a hermetic test
fixture so the V3.2 fix-set cannot regress without CI catching it.

I-V3.2-09 — composite end-to-end assertion locking all 3 fixes.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


class PhaseV3_2FreshRunReplay(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_2-replay-"))
        self.workspace = self.tmp / "workspace"
        self.tools_root = self.workspace / "aria-tools"

    # I-V3.2-09 — composite holistic replay.
    def test_i_v3_2_09_fresh_run_no_regression(self) -> None:
        """Plan ARIA-V3.2 Phase 3.4 — replicates the operator's
        10-agent audit scenario end-to-end:

          (1) Init minimal git repo + add untracked dirty file.
          (2) Run ``run_discovery`` (forces dirty-tree path → D3 fix
              checked).
          (3) ``run_reflection`` with absolute base_dir (D2 fix
              checked).
          (4) Re-record a belief in cycle-2 (D1 fix checked —
              freshness fields refresh).

        Asserts:
          * D3 — discovery_dirty_tree_skipped governance row
            carries cycle_id.
          * D2 — reflection's daily report renders correct Total
            governance events (data + label semantics).
          * D1 — beliefs recorded across cycles refresh
            base_commit_sha + last_seen_cycle.
        """
        from aria_kernel.discovery import run_discovery
        from aria_kernel.memory import _record_belief, latest_beliefs
        from aria_kernel.reflection import run_reflection
        from aria_kernel.ledger import load_jsonl
        from tests.invariants.v3_2._helpers import (
            init_minimal_git_repo,
            read_governance_rows,
        )

        # --- Setup: init minimal repo + add dirty file ---
        sha1 = init_minimal_git_repo(
            self.workspace,
            {
                "nx.json": '{"version": 2}\n',
                "package.json": '{"name": "test"}\n',
            },
        )
        (self.workspace / "dirty.txt").write_text("dirty\n", encoding="utf-8")

        # --- Cycle 1: run discovery ---
        cycle_1 = "cycle-replay-1"
        run_discovery(
            workspace_root=self.workspace,
            cycle_id=cycle_1,
            base_dir=self.tools_root,
            snapshot_mode="committed",
        )

        # --- D3 assertion: discovery_dirty_tree_skipped has cycle_id ---
        rows = read_governance_rows(self.tools_root)
        dirty_rows = [r for r in rows if r.get("kind") == "discovery_dirty_tree_skipped"]
        self.assertGreaterEqual(
            len(dirty_rows), 1,
            msg="discovery_dirty_tree_skipped MUST fire when dirty file present",
        )
        self.assertEqual(
            dirty_rows[0]["details"].get("cycle_id"), cycle_1,
            msg=(
                "Plan ARIA-V3.2 §2c F-010 D3 — "
                "discovery_dirty_tree_skipped MUST carry cycle_id"
            ),
        )

        # --- Cycle 1: record belief via support path ---
        _record_belief(
            self.tools_root,
            cycle_id=cycle_1,
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )

        # --- D2 assertion: reflection reads canonical absolute path ---
        reflection = run_reflection(
            cycle_id=cycle_1,
            base_dir=self.tools_root,
            repo_root=self.workspace,
        )
        ga = reflection.get("gate_activity", {})
        # The Total events field MUST reflect ALL rows in canonical
        # governance.jsonl (no shadow-tree drift).
        actual_governance_count = len(read_governance_rows(self.tools_root))
        self.assertEqual(
            ga.get("total_events"),
            actual_governance_count,
            msg=(
                "Plan ARIA-V3.2 §2b F-010 D2 — reflection's "
                "total_events MUST equal actual governance.jsonl row count"
            ),
        )
        day = str(reflection["recorded_at"])[:10]
        report_path = self.tools_root / "reports" / "daily" / f"{day}.md"
        self.assertTrue(report_path.exists())
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn(
            f"Total governance events: {actual_governance_count}",
            report_text,
        )

        # --- Cycle 2: re-record belief, assert D1 freshness refresh ---
        import time
        time.sleep(1.1)
        cycle_2 = "cycle-replay-2"
        # Add a new file so the second cycle has a distinct SHA.
        (self.workspace / "src" / "new.py").parent.mkdir(
            parents=True, exist_ok=True,
        )
        (self.workspace / "src" / "new.py").write_text("# new\n", encoding="utf-8")
        sha2 = init_minimal_git_repo(
            self.workspace / "cycle2_repo",
            {"nx.json": '{"version": 2}\n', "package.json": '{"name": "test"}\n', "src/new.py": "# new\n"},
        )
        # Use the SAME tools_root but the new cycle's discovery
        # path. Real run_discovery would update FATES; we simulate
        # the minimum so _record_belief's _repo_state finds the
        # cycle-2 COMPLETION_PROOF.json.
        discovery2 = self.tools_root / "discovery" / cycle_2
        discovery2.mkdir(parents=True, exist_ok=True)
        (discovery2 / "COMPLETION_PROOF.json").write_text(
            json.dumps({
                "schema_version": 1,
                "cycle_id": cycle_2,
                "complete": True,
                "base_commit_sha": sha2,
                "snapshot_hash": "sha256:" + ("0" * 64),
                "repo_state_id": "repo-state:" + sha2,
                "snapshot_mode": "committed",
                "dirty_snapshot": False,
                "dirty_path_count": 0,
                "file_counts": {
                    "allowed": 3, "fated": 3, "generated": 0,
                    "git_tracked": 3, "unknown": 0, "working_tree": 3,
                },
                "tracked_file_count": 3,
                "fated_file_count": 3,
                "unknown_count": 0,
                "missing_fates": [],
            }),
            encoding="utf-8",
        )
        (discovery2 / "FATES.json").write_text(
            json.dumps({
                "schema_version": 1,
                "cycle_id": cycle_2,
                "files": [
                    {"path": "nx.json", "fate": "tracked", "content_hash": "sha256:" + ("0"*64), "size_bytes": 16, "suffix": ".json"},
                    {"path": "package.json", "fate": "tracked", "content_hash": "sha256:" + ("1"*64), "size_bytes": 20, "suffix": ".json"},
                    {"path": "src/new.py", "fate": "tracked", "content_hash": "sha256:" + ("2"*64), "size_bytes": 8, "suffix": ".py"},
                ],
            }),
            encoding="utf-8",
        )
        _record_belief(
            self.tools_root,
            cycle_id=cycle_2,
            belief_id="repo-uses-nx",
            claim="repo uses Nx",
            evidence_refs=["nx.json"],
            confidence=1.0,
        )

        # --- D1 assertion: belief refreshed to cycle-2 SHA ---
        all_rows = load_jsonl(self.tools_root / "memory" / "beliefs.jsonl")
        latest = {r["belief_id"]: r for r in latest_beliefs(all_rows)}
        self.assertEqual(
            latest["repo-uses-nx"]["base_commit_sha"], sha2,
            msg=(
                "Plan ARIA-V3.2 §2a F-010 D1 — re-recorded belief "
                "MUST carry cycle-2's base_commit_sha"
            ),
        )
        self.assertEqual(
            latest["repo-uses-nx"]["last_seen_cycle"], cycle_2,
        )


if __name__ == "__main__":
    unittest.main()
