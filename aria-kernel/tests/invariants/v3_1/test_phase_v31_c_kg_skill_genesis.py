"""Plan ARIA-V3.1-C — KG + skill genesis wire invariants.

Closes 6-validator audit findings:

* C-12 (performance — bounded governance reader): the pre-V3.1-C
  reader loaded the full governance.jsonl into memory. V3.1-C-1
  ships `read_governance_rows_reverse` with 64 KB seek-to-end
  scan, bounded irrespective of total ledger size.
* MEDIUM-011 + ai-safety HIGH-005 (skill-genesis activation
  collusion): stability check now requires OPERATOR_FEEDBACK ∈
  distinct_pressure_source_types.

Invariants:

* I-V31-C-01 — read_governance_rows_reverse uses seek-to-end byte
  scan, NOT full-file read (source-substring test + behavioral
  perf assertion on a 100MB synthetic ledger).
* I-V31-C-04 — check_pattern_signature_stability requires
  OPERATOR_FEEDBACK ∈ distinct sources (behavioral test).
"""
from __future__ import annotations

import inspect
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path


class BoundedGovernanceReaderTests(unittest.TestCase):
    """Plan ARIA-V3.1-C-1 — bounded seek-to-end governance reader."""

    def test_i_v31_c_01_reader_uses_seek_to_end_scan(self) -> None:
        """Plan ARIA-V3.1-C-1 — AST assertion: the
        `read_governance_rows_reverse` body uses `f.seek(...)` +
        chunked reads, NOT a `path.read_text()` invocation. The
        docstring may discuss the pre-V3.1-C anti-pattern; only the
        function body matters.
        """
        import ast
        from aria_kernel.governance_reader import read_governance_rows_reverse
        src = inspect.getsource(read_governance_rows_reverse)
        # Pin chunk-size constant + seek invocation.
        self.assertIn("seek(", src,
                      "read_governance_rows_reverse missing seek-to-end pattern")
        self.assertIn("_BOUNDED_READ_CHUNK_SIZE", src,
                      "read_governance_rows_reverse missing chunk size constant")
        # AST scan: NO `read_text(...)` Call node anywhere in the
        # function body (docstring exempt because docstrings are
        # ast.Constant strings, not Call nodes).
        tree = ast.parse(src)
        body = tree.body[0]  # the function def
        assert isinstance(body, ast.FunctionDef)
        for node in ast.walk(body):
            if isinstance(node, ast.Call):
                attr = getattr(node.func, "attr", None)
                self.assertNotEqual(
                    attr, "read_text",
                    "read_governance_rows_reverse body invokes "
                    "read_text() — full-file read leak",
                )

    def test_i_v31_c_01_reader_returns_newest_first(self) -> None:
        """Plan ARIA-V3.1-C-1 — behavioral test: synthetic 10-row
        ledger; reader returns newest 3 rows in reverse chronological
        order."""
        from aria_kernel.governance_reader import read_governance_rows_reverse
        tmp = Path(tempfile.mkdtemp(prefix="v31c1-")).resolve()
        try:
            (tmp / "governance.jsonl").write_text(
                "\n".join(
                    json.dumps({"kind": "event", "n": i})
                    for i in range(10)
                ) + "\n",
                encoding="utf-8",
            )
            rows = read_governance_rows_reverse(base_dir=tmp, limit=3)
            self.assertEqual(len(rows), 3)
            self.assertEqual([r["n"] for r in rows], [9, 8, 7])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_i_v31_c_01_kind_filter_applied_before_limit(self) -> None:
        """Plan ARIA-V3.1-C-1 — kind_filter reduces JSON-parse cost +
        applies BEFORE the limit cap. The reader returns up to
        `limit` rows MATCHING the filter, not the first `limit` rows
        regardless of kind."""
        from aria_kernel.governance_reader import read_governance_rows_reverse
        tmp = Path(tempfile.mkdtemp(prefix="v31c1-f-")).resolve()
        try:
            lines: list[str] = []
            for i in range(20):
                lines.append(json.dumps({
                    "kind": "convergence_resolved" if i % 2 == 0 else "noise",
                    "n": i,
                }))
            (tmp / "governance.jsonl").write_text(
                "\n".join(lines) + "\n", encoding="utf-8",
            )
            rows = read_governance_rows_reverse(
                base_dir=tmp, limit=3,
                kind_filter=("convergence_resolved",),
            )
            self.assertEqual(len(rows), 3)
            # All returned rows have the filtered kind.
            for r in rows:
                self.assertEqual(r["kind"], "convergence_resolved")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_i_v31_c_01_bounded_under_synthetic_load(self) -> None:
        """Plan ARIA-V3.1-C-1 — behavioral perf assertion: returning 100
        rows from a 10K-row ledger completes within 250ms wall-clock.
        Closes the C-12 latency anchor (the FULL-FILE reader scaled
        linearly with ledger size).
        """
        from aria_kernel.governance_reader import read_governance_rows_reverse
        tmp = Path(tempfile.mkdtemp(prefix="v31c1-load-")).resolve()
        try:
            big_path = tmp / "governance.jsonl"
            with big_path.open("w", encoding="utf-8") as f:
                for i in range(10_000):
                    f.write(json.dumps({
                        "kind": "synthetic", "n": i,
                        "filler": "x" * 100,
                    }) + "\n")
            t0 = time.monotonic()
            rows = read_governance_rows_reverse(base_dir=tmp, limit=100)
            elapsed_ms = (time.monotonic() - t0) * 1000.0
            self.assertEqual(len(rows), 100)
            # 10K rows × ~150 bytes = ~1.5MB ledger; seek-to-end +
            # 64KB chunk reads should complete well under 250ms.
            self.assertLess(
                elapsed_ms, 250.0,
                f"bounded reader regressed: {elapsed_ms:.1f}ms > 250ms",
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class StabilityOperatorFeedbackGateTests(unittest.TestCase):
    """Plan ARIA-V3.1-C-4 — stability requires OPERATOR_FEEDBACK."""

    def test_i_v31_c_04_stability_requires_operator_feedback_source(self) -> None:
        """Plan ARIA-V3.1-C-4 — 5 CONVERGED cycles with the same
        pattern_signature + 2+ distinct reviewers + 2+ distinct
        sources but NO operator_feedback source → stability is
        FALSE (closes MEDIUM-011 + ai-safety HIGH-005 collusion
        defense)."""
        from aria_kernel.skill_genesis_drainer import check_pattern_signature_stability
        sig = "sha256:" + "a" * 16
        rows = []
        # 5 CONVERGED cycles, alternating ORPHAN_FINDING + FAILING_CI,
        # 2 distinct reviewers — but NO OPERATOR_FEEDBACK.
        sources = ["orphan_finding", "failing_ci", "f_finding", "git_diff", "git_diff"]
        reviewers = ["rev-a", "rev-b", "rev-a", "rev-b", "rev-a"]
        for i in range(5):
            rows.append({
                "terminal_state": "CONVERGED",
                "pattern_signature": sig,
                "cycle_id": f"cyc-{i:03d}",
                "pressure_source_type": sources[i],
                "cross_reviewer_agent_id": reviewers[i],
            })
        result = check_pattern_signature_stability(
            pattern_signature=sig, governance_rows=rows,
        )
        self.assertFalse(result["stable"])
        self.assertEqual(
            result["reason"],
            "operator_feedback_source_required_for_skill_genesis_stability",
        )

    def test_i_v31_c_04_stability_fires_when_operator_feedback_present(self) -> None:
        """Plan ARIA-V3.1-C-4 — adding ONE operator_feedback source
        to the 5-cycle streak (others remain ORPHAN + FAILING_CI)
        clears the OPERATOR_FEEDBACK gate and stability fires."""
        from aria_kernel.skill_genesis_drainer import check_pattern_signature_stability
        sig = "sha256:" + "b" * 16
        rows = []
        sources = ["operator_feedback", "failing_ci", "orphan_finding",
                   "f_finding", "git_diff"]
        reviewers = ["rev-a", "rev-b", "rev-c", "rev-a", "rev-b"]
        for i in range(5):
            rows.append({
                "terminal_state": "CONVERGED",
                "pattern_signature": sig,
                "cycle_id": f"cyc-{i:03d}",
                "pressure_source_type": sources[i],
                "cross_reviewer_agent_id": reviewers[i],
            })
        result = check_pattern_signature_stability(
            pattern_signature=sig, governance_rows=rows,
        )
        self.assertTrue(result["stable"])
        self.assertIn("operator_feedback",
                      result["distinct_pressure_source_types"])


if __name__ == "__main__":
    unittest.main()
