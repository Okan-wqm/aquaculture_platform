"""Plan 026R §E.4 — skill_birth routing kernel constant.

4 tests:

* SKILL_BIRTH_ROUTING_TARGET constant equals "skill_genesis".
* pressure with drives=["skill_birth"] routes to skill_genesis
  REGARDLESS of routing.json table content.
* pressure with no skill_birth in drives uses the routing table normally.
* tampered routing.json mapping skill_birth → agent_genesis is
  IGNORED — the constant short-circuits before the table lookup.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.triage import SKILL_BIRTH_ROUTING_TARGET, resolve_target_agent


class SkillBirthRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-e4-"))
        self.tools = self.tmp / "aria-tools"
        self.tools.mkdir()

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_routing(self, mapping: dict) -> None:
        path = self.tools / "triage" / "agent-routing.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        # Per triage._routing_table: wrap under "routes" key OR
        # provide a top-level dict; both are accepted.
        path.write_text(json.dumps({"routes": mapping}), encoding="utf-8")

    def test_skill_birth_routing_constant(self) -> None:
        self.assertEqual(SKILL_BIRTH_ROUTING_TARGET, "skill_genesis")

    def test_skill_birth_drive_routes_to_skill_genesis(self) -> None:
        # Routing table is empty; constant short-circuits.
        self._write_routing({})
        pressure = {"drives": ["skill_birth"], "capability_gap_key": "x"}
        self.assertEqual(
            resolve_target_agent(pressure, self.tools),
            "skill_genesis",
        )

    def test_skill_birth_overrides_tampered_routing_table(self) -> None:
        # A malicious / misconfigured routing.json maps skill_birth →
        # agent_genesis. The §E.4 constant overrides.
        self._write_routing({"skill_birth": "agent_genesis"})
        pressure = {"drives": ["skill_birth"]}
        self.assertEqual(
            resolve_target_agent(pressure, self.tools),
            "skill_genesis",
        )

    def test_non_skill_birth_uses_routing_table_normally(self) -> None:
        self._write_routing({
            "auth:tenant-isolation": "auth-security-expert",
        })
        pressure = {
            "capability_gap_key": "auth:tenant-isolation",
            "drives": ["other_drive"],
        }
        self.assertEqual(
            resolve_target_agent(pressure, self.tools),
            "auth-security-expert",
        )


if __name__ == "__main__":
    unittest.main()
