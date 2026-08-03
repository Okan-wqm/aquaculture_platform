"""Wave 1 §2.1 — integrity coverage derives from the manifest (I-W2-01).

ORPHAN-HIGH-433: ``covered_tool_ledgers`` was a hand list (4 required +
28 optional names) while ``state_manifest`` declared ~129 tools-root
ledger surfaces — memory/*, enterprise/*, change-ledger/*, validation/*,
queues/* were hash-chained on every write and never verified. And the
same hand-list disease lived on the index side (ORPHAN-HIGH-525): the
grouped refresh REPLACES ``ledger_hashes`` with its own membership on
every indexed append, so ``update_tools_index`` and the verifier working
from any wider set planted or expected entries the next append silently
discarded.

WHAT IS ASSERTED HERE, and why each one is not obvious:

  1. coverage IS the manifest projection — computed independently here,
     so a hand list cannot come back without this test failing;
  2. a previously-blind surface auto-enrolls the moment its file exists —
     declaring a surface is enrolling it, no second bookkeeping step;
  3. tampering a previously-blind ledger now FAILS verification — the
     433 property itself, asserted through the public verify;
  4. all three index parties (grouped refresh, full rewrite, verifier)
     agree by construction: verify stays green ACROSS an indexed append
     that follows a full rewrite — the exact sequence the replace-discard
     defect corrupted.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import load_index, tools_index_group_ledgers
from aria_kernel.state_manifest import iter_surfaces
from aria_kernel.tool_registry import (
    CORE_TOOL_LEDGER_SURFACES,
    append_tools_governance,
    covered_tool_ledgers,
    ensure_tools_dir,
    update_tools_index,
)
from tests._helpers.declared_fixtures import append_declared_fixture


def _manifest_projection(root: Path) -> dict[str, Path]:
    """The projection computed a second way — the test's own witness."""
    expected: dict[str, Path] = {}
    for surface in iter_surfaces():
        if surface.root_kind != "tools" or surface.state_class != "ledger":
            continue
        if "*" in surface.path_pattern:
            for match in sorted(root.glob(surface.path_pattern)):
                if match.is_file():
                    expected[f"{surface.name}:{match.relative_to(root).as_posix()}"] = match
        else:
            path = root / surface.path_pattern
            if surface.name in CORE_TOOL_LEDGER_SURFACES or path.exists():
                expected[surface.name] = path
    return expected


class ManifestDerivedCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-cov-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_coverage_is_exactly_the_manifest_projection(self) -> None:
        """I-W2-01 — derived, and a hand list cannot quietly return."""
        self.assertEqual(covered_tool_ledgers(self.tools), _manifest_projection(self.tools))
        append_declared_fixture(
            self.tools / "memory" / "beliefs.jsonl",
            {"schema_version": 1, "belief_id": "B-cov"},
            expected_surface="memory_beliefs",
        )
        self.assertEqual(covered_tool_ledgers(self.tools), _manifest_projection(self.tools))

    def test_a_previously_blind_surface_auto_enrolls(self) -> None:
        before = set(covered_tool_ledgers(self.tools))
        self.assertEqual(
            before & {"memory_beliefs"}, set(),
            "fixture precondition: the ledger does not exist yet",
        )
        append_declared_fixture(
            self.tools / "memory" / "beliefs.jsonl",
            {"schema_version": 1, "belief_id": "B-1"},
            expected_surface="memory_beliefs",
        )
        after = covered_tool_ledgers(self.tools)
        self.assertIn("memory_beliefs", after)
        self.assertEqual(
            set(after) - before, {"memory_beliefs"},
            "declaring+writing one surface enrolls exactly that surface",
        )

    def test_tampering_a_previously_blind_ledger_fails_verification(self) -> None:
        """The 433 property: the old hand list never looked at this file."""
        path = self.tools / "memory" / "beliefs.jsonl"
        append_declared_fixture(
            path, {"schema_version": 1, "belief_id": "B-tamper"},
            expected_surface="memory_beliefs",
        )
        self.assertTrue(verify_integrity(base_dir=self.tools)["valid"])
        content = path.read_text(encoding="utf-8").replace("B-tamper", "B-forged")
        path.write_text(content, encoding="utf-8")
        report = verify_integrity(base_dir=self.tools)
        self.assertFalse(report["valid"])
        codes = {
            (issue.get("code"), issue.get("ledger"))
            for issue in report["tools"]["issues"]
        }
        self.assertIn(("tools_ledger_invalid", "memory_beliefs"), codes)

    def test_index_parties_agree_across_rewrite_then_append(self) -> None:
        """ORPHAN-HIGH-525's killing sequence, now structurally safe.

        Full rewrite → indexed append → verify. Pre-fix the rewrite wrote
        the wide covered set, the append REPLACED ledger_hashes with the
        group membership, and verify (expecting the wide set again) found
        nulls. All three now consume ``tools_index_group_ledgers``.
        """
        append_declared_fixture(
            self.tools / "memory" / "beliefs.jsonl",
            {"schema_version": 1, "belief_id": "B-idx"},
            expected_surface="memory_beliefs",
        )
        update_tools_index(self.tools)
        written = set(load_index(self.tools / "integrity_index.json").get("ledger_hashes", {}))
        self.assertEqual(
            written, set(tools_index_group_ledgers(self.tools)),
            "the full rewrite must persist exactly the index membership",
        )
        append_tools_governance(self.tools, "coverage_probe", {"probe": True})
        report = verify_integrity(base_dir=self.tools)
        self.assertTrue(
            report["valid"],
            f"verify after rewrite+append must hold: {report['tools']['issues']!r}",
        )


if __name__ == "__main__":
    unittest.main()
