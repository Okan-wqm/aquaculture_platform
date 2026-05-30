"""Plan ARIA-V3.2 Phase 3.2 — D2 reflection absolute-path assertion.

The 10-agent post-V4 fresh-run audit found:

  * Daily report `aria-tools/reports/daily/2026-05-16.md` said
    "Total governance events: 4" but actual `aria-tools/governance.jsonl`
    had 29 rows.
  * Phase 1 Explore + Phase 2 Plan agents traced root cause to
    `tool_registry.tools_dir()`'s CWD-relative fallback creating a
    SHADOW `aria-kernel/aria-tools/` tree when reflection is invoked
    from a subdirectory.

V3.2 NARROW SCOPE FIX (Tier-2, "make automatic"):

  * `run_reflection` raises `GovernanceError("reflection_requires_absolute_tools_root")`
    when `base_dir` is relative. The full `tools_dir()` Tier-1 rewrite
    is tracked under Plan ARIA-V3.3 §2 (F-010-D4) because ~30
    callsites depend on the relative fallback.

Three invariant cases:

  * I-V3.2-04 `test_reflection_reads_governance_from_absolute_path` —
    seed governance rows under temp dir; chdir to sibling; assert
    reflection reads from the ABSOLUTE base_dir, not the relative
    fallback.
  * I-V3.2-05 `test_reflection_total_events_label_matches_data` —
    distinct fields for all-time total vs 24h-window count are
    rendered correctly in the daily report.
  * I-V3.2-06 `test_reflection_rejects_relative_base_dir` — fail-fast
    on relative base_dir per the V3.2 assertion.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _minimal_cycle_state(tools_root: Path, cycle_id: str) -> None:
    """Plan ARIA-V3.2 — seed the bare-minimum cycle state that
    ``run_reflection`` requires (memory, runs, pressure, discovery
    cycle dir). Empty ledgers are valid; the invariant tests don't
    need real data here — they're testing path resolution.
    """
    (tools_root / "memory").mkdir(parents=True, exist_ok=True)
    (tools_root / "memory" / "beliefs.jsonl").touch()
    (tools_root / "auto-merge-decisions.jsonl").touch()
    discovery_dir = tools_root / "discovery" / cycle_id
    discovery_dir.mkdir(parents=True, exist_ok=True)
    import json
    (discovery_dir / "COMPLETION_PROOF.json").write_text(
        json.dumps({
            "schema_version": 1,
            "cycle_id": cycle_id,
            "complete": True,
            "file_counts": {
                "allowed": 0, "fated": 0, "generated": 0,
                "git_tracked": 0, "unknown": 0, "working_tree": 0,
            },
            "tracked_file_count": 0,
            "fated_file_count": 0,
            "unknown_count": 0,
            "missing_fates": [],
            "snapshot_hash": "sha256:" + ("0" * 64),
            "base_commit_sha": "0" * 40,
            "snapshot_mode": "committed",
            "dirty_snapshot": False,
            "dirty_path_count": 0,
        }),
        encoding="utf-8",
    )


class PhaseV3_2ReflectionPathResolution(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v3_2-reflection-"))
        self.original_cwd = os.getcwd()

    def tearDown(self) -> None:
        os.chdir(self.original_cwd)

    # I-V3.2-04 — reflection reads from absolute base_dir, not relative.
    def test_i_v3_2_04_reflection_reads_governance_from_absolute_path(
        self,
    ) -> None:
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_2._helpers import (
            read_governance_rows,
            seed_governance_jsonl,
        )

        cycle_id = "cycle-v3_2-04"
        canonical_tools = self.tmp / "canonical" / "aria-tools"
        canonical_tools.mkdir(parents=True)
        # Seed 5 governance rows in the canonical tools_root.
        seed_governance_jsonl(
            canonical_tools,
            {"agent_fitness_computed": 5},
            cycle_id=cycle_id,
        )
        _minimal_cycle_state(canonical_tools, cycle_id)

        # Decoy shadow tree elsewhere with 99 rows. If reflection
        # used CWD-relative resolution, it would pick this up.
        decoy_parent = self.tmp / "decoy"
        decoy_parent.mkdir()
        decoy_tools = decoy_parent / "aria-tools"
        decoy_tools.mkdir()
        seed_governance_jsonl(
            decoy_tools,
            {"agent_fitness_computed": 99},
            cycle_id="decoy-cycle",
        )

        # Change CWD to decoy parent — relative fallback would
        # resolve to decoy/aria-tools.
        os.chdir(decoy_parent)

        reflection = run_reflection(
            cycle_id=cycle_id,
            base_dir=canonical_tools,  # absolute path
        )
        ga = reflection.get("gate_activity", {})
        # The bootstrap path adds `tools_root_bootstrapped` to the
        # canonical ledger; we asserted on the SEEDED kind to avoid
        # off-by-bootstrap noise. Canonical has 5
        # `agent_fitness_computed`; decoy has 99.
        by_kind = ga.get("by_kind", {})
        self.assertEqual(
            by_kind.get("agent_fitness_computed"), 5,
            msg=(
                f"reflection read decoy ledger instead of canonical "
                f"absolute base_dir — got "
                f"agent_fitness_computed={by_kind.get('agent_fitness_computed')} "
                f"expected 5 (decoy would have given 99). "
                f"Full by_kind={by_kind}"
            ),
        )
        # Plan ARIA-V3.2 §2b sanity — total_events bounded;
        # canonical (5 seeded + 1 bootstrap = 6) vs decoy (100). If
        # reflection silently switched to decoy, total would be ≥99.
        self.assertLess(
            ga.get("total_events", 0), 50,
            msg=(
                f"total_events={ga.get('total_events')} suggests "
                f"decoy ledger was read"
            ),
        )

    # I-V3.2-05 — label-vs-data semantics for total vs 24h window.
    def test_i_v3_2_05_total_events_label_matches_data(self) -> None:
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_2._helpers import seed_governance_jsonl

        cycle_id = "cycle-v3_2-05"
        tools_root = self.tmp / "case_05" / "aria-tools"
        tools_root.mkdir(parents=True)
        # Seed 10 rows (all within 24h since seed_governance_jsonl
        # uses utc_now()).
        seed_governance_jsonl(
            tools_root,
            {"agent_fitness_computed": 10},
            cycle_id=cycle_id,
        )
        _minimal_cycle_state(tools_root, cycle_id)

        reflection = run_reflection(
            cycle_id=cycle_id,
            base_dir=tools_root,
        )
        ga = reflection.get("gate_activity", {})
        # The "Total events" field MUST equal len(governance.jsonl).
        # Includes 10 seeded + 1 bootstrap event.
        self.assertEqual(ga.get("total_events"), 11)
        by_kind = ga.get("by_kind", {})
        self.assertEqual(by_kind.get("agent_fitness_computed"), 10)
        # The "recent_24h" subset MUST be ≤ total (all fresh writes
        # land inside the 24h window).
        recent = ga.get("recent_24h", {})
        recent_sum = sum(recent.values()) if isinstance(recent, dict) else 0
        self.assertLessEqual(recent_sum, ga.get("total_events"))
        # The daily report MUST render distinct lines for the two
        # quantities. Read the rendered markdown.
        day = str(reflection["recorded_at"])[:10]
        report_path = tools_root / "reports" / "daily" / f"{day}.md"
        self.assertTrue(report_path.exists())
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn(
            f"Total governance events: {ga.get('total_events')}",
            report_text,
            msg=(
                "Daily report 'Total governance events' line MUST "
                "render the all-time count, not the 24h subset"
            ),
        )
        self.assertIn(
            "Events in last", report_text,
            msg=(
                "Daily report MUST render a distinct 'Events in "
                "last <N>h' line for the windowed count"
            ),
        )

    # I-V3.2-06 — relative base_dir is resolved to absolute (hotfix).
    def test_i_v3_2_06_reflection_resolves_relative_base_dir(self) -> None:
        """Plan ARIA-V3.2 §2b hotfix — the V3.2 first-attempt
        RAISED on relative ``base_dir``, but the CLI's normal path
        passes a relative literal. The hotfix converts relative to
        absolute via ``.resolve()`` rather than rejecting.

        This invariant verifies the relative path is normalized
        WITHOUT exception. The deeper CWD-shadow-tree class is
        tracked under Plan ARIA-V3.3 §2 (F-010-D4); the V3.2
        hotfix preserves the normal CLI path while keeping
        ``run_reflection`` documented as expecting an absolute
        tools root post-normalization.
        """
        from aria_kernel.reflection import run_reflection
        from tests.invariants.v3_2._helpers import seed_governance_jsonl

        cycle_id = "cycle-v3_2-06"
        # Seed a tools_root under cwd so .resolve() finds it.
        os.chdir(self.tmp)
        rel_tools = Path("aria-tools")  # allowlist-aria-tools-literal: V3.2 hotfix + V3.3 §2a verify relative input gets resolved to absolute, not rejected
        abs_tools = (self.tmp / "aria-tools").resolve()
        abs_tools.mkdir(parents=True, exist_ok=True)
        seed_governance_jsonl(
            abs_tools,
            {"agent_fitness_computed": 1},
            cycle_id=cycle_id,
        )
        _minimal_cycle_state(abs_tools, cycle_id)
        # The hotfix MUST NOT raise on a relative path. It should
        # resolve to absolute against cwd.
        reflection = run_reflection(
            cycle_id=cycle_id,
            base_dir=rel_tools,  # allowlist-aria-tools-literal: V3.2 hotfix verifies the relative-path-resolution path works without raise
        )
        ga = reflection.get("gate_activity", {})
        self.assertGreater(
            ga.get("total_events", 0), 0,
            msg=(
                "V3.2 hotfix — relative base_dir must resolve to "
                "the absolute tools root via .resolve() WITHOUT "
                "raising; reflection should produce a normal payload"
            ),
        )


if __name__ == "__main__":
    unittest.main()
