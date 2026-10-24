"""Coverage-gap → genesis candidate source (ORPHAN-MEDIUM-261, slice 5).

A service ARIA examined that has active pressure but NO owning routing-table
agent becomes an agent-genesis candidate, fed into the EXISTING (human-gated)
genesis request flow via capability_gap.detect_capability_gaps.
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

import aria_kernel.capability_gap as cg  # noqa: E402
from aria_kernel.agent_routing import ROUTING_TABLE_REL  # noqa: E402


class CoverageGapSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = (cg.unowned_projects, cg.effective_workspace_pressures)

    def tearDown(self) -> None:
        cg.unowned_projects, cg.effective_workspace_pressures = self._orig

    def _run(self, unowned, pressures, related):
        cg.unowned_projects = lambda **k: unowned
        cg.effective_workspace_pressures = lambda paths: pressures
        paths = types.SimpleNamespace(repo_root="/repo")
        # ``related``: the agents the routing table notifies for the unowned
        # service (no primary, or it would not be unowned).
        routing = [{"prefixes": sorted(unowned.values()), "primary": [], "also_notify": related}] if related else []
        return cg._gaps_from_coverage_gaps("c1", paths, Path("/tmp"), "idx", None, routing)

    def test_unowned_and_active_service_yields_agent_gap(self) -> None:
        gaps = self._run(
            unowned={"svc": "apps/svc"},
            pressures=[{"event_id": "p1", "effective_state": "active",
                        "evidence_refs": ["apps/svc/src/db.ts"]}],
            related=[],
        )
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["gap_type"], "agent_gap")
        self.assertEqual(gaps[0]["capability_gap_key"], "coverage:svc")
        self.assertEqual(gaps[0]["primary_source"], "coverage")
        self.assertEqual(gaps[0]["blocked_by"], [])
        self.assertIn(ROUTING_TABLE_REL, gaps[0]["evidence_refs"])

    def test_owned_service_pressure_is_ignored(self) -> None:
        # the pressure lands in an owned service (not in `unowned`) → no gap
        gaps = self._run(
            unowned={"svc": "apps/svc"},
            pressures=[{"event_id": "p", "effective_state": "active",
                        "evidence_refs": ["apps/owned/src/y.ts"]}],
            related=[],
        )
        self.assertEqual(gaps, [])

    def test_unowned_but_inactive_service_yields_nothing(self) -> None:
        # unowned, but no pressure touches it → not a request (low-noise)
        gaps = self._run(
            unowned={"svc": "apps/svc"},
            pressures=[{"event_id": "p", "effective_state": "active",
                        "evidence_refs": ["aria-tools/x.json"]}],
            related=[],
        )
        self.assertEqual(gaps, [])

    def test_related_agent_prefers_extension(self) -> None:
        gaps = self._run(
            unowned={"svc": "apps/svc"},
            pressures=[{"event_id": "p", "effective_state": "active",
                        "evidence_refs": ["apps/svc/src/a.ts"]}],
            related=["data-expert"],
        )
        self.assertEqual(gaps[0]["gap_type"], "existing_agent_extension")
        self.assertEqual(gaps[0]["recommended_action"], "extend_existing_agent")
        self.assertEqual(gaps[0]["related_existing_agents"], ["data-expert"])

    def test_a_gap_cites_only_the_refs_inside_its_own_service(self) -> None:
        # One pressure spanning two unowned services, an owned service and a
        # non-service path, plus a second pressure repeating a ref in another
        # spelling: each gap cites its own service's ref, once.
        gaps = self._run(
            unowned={"svc": "apps/svc", "other": "apps/other"},
            pressures=[
                {"event_id": "p1", "effective_state": "active",
                 "evidence_refs": ["apps/svc/a.ts", "apps/other/b.ts",
                                   "apps/owned/c.ts", "aria-tools/x.json"]},
                {"event_id": "p2", "effective_state": "active",
                 "evidence_refs": ["./apps/svc/a.ts"]},
            ],
            related=[],
        )
        by_key = {gap["capability_gap_key"]: gap for gap in gaps}
        self.assertEqual(
            by_key["coverage:svc"]["evidence_refs"],
            [ROUTING_TABLE_REL, "apps/svc", "apps/svc/a.ts"],
        )
        self.assertEqual(
            by_key["coverage:other"]["evidence_refs"],
            [ROUTING_TABLE_REL, "apps/other", "apps/other/b.ts"],
        )
        # The consequence that made the foreign refs a defect: a genesis
        # draft's scope_globs come from these refs, so another service's
        # path would widen the drafted agent's scope to that service. The
        # scope is the root of each project the refs lie in, over the
        # workspace's project map (SE-1 round 2).
        from aria_kernel.agent_genesis import _scope_from_evidence

        self.assertEqual(
            _scope_from_evidence(
                by_key["coverage:svc"]["evidence_refs"],
                {"svc": "apps/svc", "other": "apps/other", "owned": "apps/owned"},
            ),
            ["apps/svc/**"],
        )

    def test_no_unowned_projects_is_safe(self) -> None:
        self.assertEqual(self._run(unowned={}, pressures=[], related=[]), [])

    def test_unowned_lookup_failure_is_swallowed(self) -> None:
        def boom(**k):
            raise RuntimeError("graph unreadable")

        cg.unowned_projects = boom
        cg.effective_workspace_pressures = lambda paths: []
        paths = types.SimpleNamespace(repo_root="/repo")
        # never raises into the cycle
        self.assertEqual(cg._gaps_from_coverage_gaps("c1", paths, Path("/tmp"), "idx", None, []), [])


if __name__ == "__main__":
    unittest.main()
