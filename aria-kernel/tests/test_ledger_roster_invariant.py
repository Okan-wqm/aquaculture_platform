"""ORPHAN-670 — the roster gap was systemic; this invariant ends the class.

Three sweeps in one program (M11/E12-b, ORPHAN-668, ORPHAN-670) each
found MORE kernel ledgers invisible to ``iter_surfaces()`` — and the
aria/state publish carries exactly the declared surfaces, so every
unrostered ledger silently died at job teardown. One-off sweeps do not
end a defect class; a gate does. This test statically sweeps every
kernel module for tools-relative ``.jsonl`` path literals and fails the
moment ANY of them neither resolves to a declared surface nor appears in
the explicit, justified exclusion table below. Ledger #22 cannot be born
unrostered without turning CI red.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.state_manifest import surface_for_relative_path

_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"

# The sweep: any path expression rooted at a tools-dir variable that ends
# in a .jsonl literal. Deliberately broad — false candidates go to the
# exclusion table WITH a reason, never silently out of the regex.
_SWEEP = re.compile(
    r'(?:\broot\b|\btools_root\b|ensure_tools_dir\([^)]*\))'
    r'\s*/\s*((?:"[^"]+"\s*/\s*)*"[^"]+\.jsonl")'
)

# Candidate → reason it is legitimately NOT a declared tools surface.
# Every entry must stay true — a reason that names a surface is
# re-verified below, so exclusions cannot rot into blind spots.
_EXCLUDED: dict[str, str] = {
    # autonomy_ladder's mock-acceptance lane exists to SIMULATE
    # acceptance events for ladder rehearsal; carrying rehearsal noise
    # across nights would pollute the real acceptance evidence.
    "aria-acceptance/mock-acceptance-events.jsonl": "mock rehearsal lane, deliberately ephemeral",
    # runtime_artifacts binds `root` to run_artifacts_root(), so the bare
    # literal hides the real declared pattern run-artifacts/artifact-index.jsonl.
    "artifact-index.jsonl": "declared under run-artifacts/ prefix as 'runtime_artifact_index'",
}

# Exclusion reasons that reference a declared surface pin that surface's
# continued existence here.
_EXCLUSION_BACKING_SURFACES = {
    "artifact-index.jsonl": "runtime_artifact_index",
}


def _sweep_candidates() -> dict[str, set[str]]:
    candidates: dict[str, set[str]] = {}
    for module in sorted(_KERNEL_DIR.glob("*.py")):
        text = module.read_text(encoding="utf-8")
        for match in _SWEEP.finditer(text):
            rel = "/".join(re.findall(r'"([^"]+)"', match.group(1)))
            candidates.setdefault(rel, set()).add(module.name)
    return candidates


class LedgerRosterInvariantTests(unittest.TestCase):
    def test_every_kernel_jsonl_literal_is_declared_or_justified(self) -> None:
        candidates = _sweep_candidates()
        self.assertTrue(candidates, "sweep found nothing — regex broke, not the repo")
        violations: list[str] = []
        for rel, modules in sorted(candidates.items()):
            if rel in _EXCLUDED:
                continue
            if surface_for_relative_path(rel) is None:
                violations.append(f"{rel} (written by {', '.join(sorted(modules))})")
        self.assertEqual(
            violations,
            [],
            "kernel ledgers with NO declared surface and NO justified "
            "exclusion — they would die at job teardown; add a "
            "StateSurface (and migrate the writer to "
            "append_declared_jsonl) or add a justified exclusion: "
            + "; ".join(violations),
        )

    def test_exclusions_are_not_stale(self) -> None:
        # An exclusion for a path the sweep no longer finds is dead
        # weight that will one day mask a REAL new ledger of the same
        # name; prune it when the writer goes away.
        candidates = _sweep_candidates()
        for rel in _EXCLUDED:
            self.assertIn(
                rel,
                candidates,
                f"exclusion {rel!r} no longer matches any kernel literal — prune it",
            )

    def test_exclusion_backing_surfaces_still_exist(self) -> None:
        for rel, surface_name in _EXCLUSION_BACKING_SURFACES.items():
            resolved = surface_for_relative_path(surface_name.replace("'", ""))
            # The reason claims the data lives on a declared surface;
            # verify by resolving that surface's own pattern.
            from aria_kernel.state_manifest import STATE_SURFACES

            self.assertIn(
                surface_name,
                {s.name for s in STATE_SURFACES},
                f"exclusion for {rel!r} claims surface {surface_name!r} which no longer exists",
            )

    def test_orphan_670_roster_resolves(self) -> None:
        # The inventory this invariant found on its first run — pinned so
        # a future manifest refactor cannot silently drop one.
        for rel, expected in {
            "findings.jsonl": "findings",
            "promotions.jsonl": "promotions",
            "quarantine.jsonl": "quarantine_log",
            "calibration.jsonl": "tool_calibration",
            "reviews.jsonl": "review_records",
            "since_migration_events.jsonl": "since_migration_events",
            "agent-priors/agent-map.jsonl": "agent_priors_map",
            "kernel-change/requests.jsonl": "kernel_change_requests",
            "observability/alerts.jsonl": "observability_alerts",
            "observability/cycle-metrics.jsonl": "observability_cycle_metrics",
            "observability/dashboards.jsonl": "observability_dashboards",
            "architecture/reviews.jsonl": "architecture_reviews",
            "architecture/option-sets.jsonl": "architecture_option_sets",
            "architecture/evidence-packs.jsonl": "architecture_evidence_packs",
            "architecture/adr-drafts.jsonl": "architecture_adr_drafts",
            "codegen/code-change-plans.jsonl": "codegen_change_plans",
            "codegen/generated-diff-packets.jsonl": "codegen_diff_packets",
            "research/sources.jsonl": "research_sources",
            "research/fetches.jsonl": "research_fetches",
            "research/policies.jsonl": "research_policies",
            "llm/proposal-amplifications.jsonl": "llm_proposal_amplifications",
        }.items():
            surface = surface_for_relative_path(rel)
            self.assertIsNotNone(surface, rel)
            self.assertEqual(surface.name, expected, rel)


if __name__ == "__main__":
    unittest.main()
