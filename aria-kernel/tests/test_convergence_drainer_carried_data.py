"""ARIA-HIGH-104 round 3 (R1) — the drainer's carried obligations quote data,
never prose.

The round-2 re-verifier found the convergence drainer's own next-round
carries embedding FOREIGN text in ``description`` — the field the mint's
banned-phrase scan reads: the coverage carry wrote the node's repository
path and the witness's reason, the spine carry ``json.dumps``'d the
comparison descriptor, the plan-contract carry echoed the plan's own
``validation_commands[].cmd``. An uncovered node whose file name carried a
banned word made the next round's primary envelope unmintable, the
``GovernanceError`` escaped the drainer's
``except BridgeContractViolation``, and the carry re-tripped every cycle —
the plan was stuck. The rule is about the kernel's OWN statement; quoted
data rides on the obligation under its own key and the prompt prints it
delimited and escaped. This module drives a real plan to CROSS_REVIEWED
with all three measured facts spelled with banned words and pins that the
primary envelope mints through the real bridge, that the prompt shows the
data, and that a kernel-authored statement that defers is still refused.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import convergence_drainer as cd
from aria_kernel.agent_invocations import render_invocation_prompt
from aria_kernel.architecture_spine_gate import InvariantMeasurement, take_baseline, take_postcheck
from aria_kernel.cross_review_bridge import issue_primary_envelope
from aria_kernel.draft_intent import BANNED_PHRASES_DEFAULT
from aria_kernel.plan_convergence import (
    content_hash,
    plan_status,
    record_cross_review,
    request_cross_review,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, utc_now

# The three measured facts, each spelled with a word the mint's scan refuses
# — read from the SSoT the scan reads, never spelled here: the gate that
# scans this repository for the phrases scans this file too.
_PATH_WORD, _SPINE_WORD, _CMD_PHRASE = BANNED_PHRASES_DEFAULT[2], BANNED_PHRASES_DEFAULT[8], BANNED_PHRASES_DEFAULT[0]
STORE_PATH = f"apps/farm-service/src/{_PATH_WORD}-store.ts"
SPINE_EVENT = f"libs/event-contracts/src/{_SPINE_WORD}-events.ts::{_SPINE_WORD.title()}Event"
UNDECLARED_CMD = f"echo skip flaky tests {_CMD_PHRASE}"
CRITIC_REASON = f"waiver rejected: the store is {_SPINE_WORD}, not removed"
MANIFEST_PATH = "aria-tools/coverage/plan-1-r1.json"


def _measurement(invariant: str, measurements: dict) -> InvariantMeasurement:
    return InvariantMeasurement(invariant=invariant, measured_at=utc_now(), measurements=measurements, source=f"fixture:{invariant}")


def _spine_checks(missing: list[str]) -> dict:
    """Injected invariant checks: one event-contract identity goes missing
    between baseline and postcheck, so the comparison names it."""
    return {
        "tenant_scoping": lambda root: _measurement("tenant_scoping", {"get_repository_callsite_count": 0}),
        "event_contracts": lambda root: _measurement(
            "event_contracts", {"missing_schema_count": len(missing), "missing_schema_identities": list(missing)},
        ),
        "schema_entity": lambda root: _measurement("schema_entity", {"missing_schema_violation_count": 0}),
        "auth_security": lambda root: _measurement("auth_security", {"pending": True}),
        "harness_security": lambda root: _measurement("harness_security", {"pending": True}),
    }


class CarriedDataMintsThroughTheRealBridge(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(f"---\nname: {name}\ndescription: r\n---\n\nOwns `{owns}`.\n", encoding="utf-8")
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def body(**overrides: object) -> dict:
        # schema_version 2 → the coverage gate applies; tier 2 → the only
        # contract violation is the one the test plants.
        base = {
            "schema_version": 2, "title": "T", "summary": "S",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["x"], "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 2,
        }
        return {**base, **overrides}

    def gaps_payload(self, **kwargs: object) -> dict:
        return {
            "round_number": kwargs["round_number"],
            "target_revision_id": kwargs["target_revision_id"],
            "target_plan_content_hash": kwargs["target_plan_content_hash"],
            "verdict": "gaps",
            "closure_manifest_path": MANIFEST_PATH,
            "closure_manifest_hash": content_hash({"manifest": "gaps"}),
            "closure_summary": {"projects": 1},
            "uncovered": [{"node_id": STORE_PATH, "kind": "source_file", "why": CRITIC_REASON}],
            "waived": [],
            "synthetic_risks": [{
                "risk_id": "COV-R1-deadbeef", "risk_category": "coverage_gap", "severity": "material",
                "summary": f"Impact-closure node {STORE_PATH} is not addressed",
                "recommendation": "Widen affected_surfaces or add a coverage.waivers entry",
                "affected_files": [MANIFEST_PATH], "evidence_refs": [f"{MANIFEST_PATH}:1"],
            }],
            "computed_at_sha": "0" * 40,
            "witness": {"tool": "tools/gates/plan-coverage-witness.ts", "exit_code": 0},
        }

    def step(self) -> dict:
        return cd.run_convergence_drainer(
            cycle_id="cyc-carried-data", base_dir=self.tools, workspace_root=self.root, plan_id="plan-1",
            plan_seed=self.body(), must_satisfy=[{"id": "MS-1", "description": "do x"}],
            evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["aria-kernel/**"], max_rounds=4,
            coverage_computer=self.gaps_payload,
        )

    def requests(self) -> list[dict]:
        path = self.tools / "agent-invocations" / "requests.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()] if path.exists() else []

    def _cross_task(self, task_id: str, reviewer: str, direction: str, rev: str, digest: str) -> dict:
        from datetime import datetime, timedelta, timezone

        return {
            "task_id": task_id, "reviewer_agent": reviewer, "review_direction": direction,
            "target_revision_id": rev, "target_plan_content_hash": digest,
            "task_packet_hash": content_hash({"t": task_id}),
            "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        }

    def drive_to_cross_reviewed(self) -> None:
        # The seed carries the undeclared command: `start_plan` is the
        # "seed no agent revised" writer the plan_contract_complete gate row
        # exists for, so the gate — not submission — records the reason.
        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.body(validation_commands=[{"cmd": UNDECLARED_CMD}]), base_dir=self.tools)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        state = plan_status(plan_id="plan-1", base_dir=self.tools)
        submit_challenger_plan(
            plan_id="plan-1",
            challenger={
                "challenger_agent": "access-boundary-auditor", "challenger_revision_id": "challenger-rev-0",
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": self.body(title="Challenger Plan"),
            },
            base_dir=self.tools,
        )
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        latest = plan_status(plan_id="plan-1", base_dir=self.tools)["latest_revision"]
        request_cross_review(
            plan_id="plan-1",
            request={"round_number": 1, "target_revision_id": latest["revision_id"],
                     "target_plan_content_hash": latest["content_hash"],
                     "tasks": [self._cross_task("task-p2c-1", "farm-expert", "primary_to_challenger", latest["revision_id"], latest["content_hash"]),
                               self._cross_task("task-c2p-1", "access-boundary-auditor", "challenger_to_primary", latest["revision_id"], latest["content_hash"])]},
            base_dir=self.tools,
        )
        for task_id, reviewer, direction in (("task-p2c-1", "farm-expert", "primary_to_challenger"),
                                             ("task-c2p-1", "access-boundary-auditor", "challenger_to_primary")):
            current = plan_status(plan_id="plan-1", base_dir=self.tools)
            task = next(t for t in current["cross_reviews"][current["current_round"]]["tasks"].values() if t["task_id"] == task_id)
            record_cross_review(
                plan_id="plan-1",
                review={"task_packet_hash": task["task_packet_hash"], "target_revision_id": task["target_revision_id"],
                        "target_plan_content_hash": task["target_plan_content_hash"], "reviewer_agent": reviewer,
                        "review_direction": direction, "risks": [], "review_content_hash": content_hash({"r": reviewer})},
                workspace_root=self.root, base_dir=self.tools,
            )
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEWED")
        take_baseline(plan_id="plan-1", cycle_id="cyc-base", workspace_root=self.root, base_dir=self.tools,
                      invariant_checks=_spine_checks([]))
        measured = take_postcheck(plan_id="plan-1", cycle_id="cyc-post", workspace_root=self.root, base_dir=self.tools,
                                  invariant_checks=_spine_checks([SPINE_EVENT]))
        self.assertEqual(measured["regression_count"], 1)

    def test_the_exact_reproduction_mints_and_the_prompt_shows_the_data(self) -> None:
        self.drive_to_cross_reviewed()
        # The step that evaluates: coverage gaps + spine regression + plan
        # contract → NEXT_ROUND_REQUIRED → the primary revision envelope.
        # Pre-fix this raised GovernanceError out of the drainer.
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        primary = [row for row in self.requests() if row["role"] == "primary_plan"]
        self.assertEqual(len(primary), 1)
        self.assertEqual(primary[0]["round_number"], 2)
        by_id = {item["id"]: item for item in primary[0]["must_satisfy"]}

        coverage = by_id[f"coverage:{STORE_PATH}"]
        self.assertEqual((coverage["node_id"], coverage["why"], coverage["kind"]), (STORE_PATH, CRITIC_REASON, "coverage_gap"))
        self.assertNotIn(_PATH_WORD, coverage["description"])
        self.assertNotIn(_SPINE_WORD, coverage["description"])

        spine_items = [item for item in by_id.values() if item.get("kind") == "architecture_spine_regression"]
        self.assertEqual(len(spine_items), 1)
        self.assertIn(SPINE_EVENT, json.dumps(spine_items[0]["spine"]))
        self.assertNotIn(_SPINE_WORD, spine_items[0]["description"])

        contract = by_id["plan_contract:plan_validation_command_not_declared"]
        self.assertEqual(contract["refused_entries"], [UNDECLARED_CMD])
        self.assertNotIn(_CMD_PHRASE, contract["description"])

        prompt = render_invocation_prompt(primary[0])
        for quoted in (STORE_PATH, CRITIC_REASON, SPINE_EVENT, UNDECLARED_CMD):
            self.assertIn(quoted, prompt)
        self.assertIn(f'<obligation_data id="coverage:{STORE_PATH}">', prompt)
        # A second step finds the live envelope: no double mint, no re-trip.
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        self.assertEqual(len([row for row in self.requests() if row["role"] == "primary_plan"]), 1)

    def test_a_kernel_authored_statement_that_defers_is_still_refused_by_the_bridge(self) -> None:
        self.drive_to_cross_reviewed()
        with self.assertRaisesRegex(GovernanceError, f"banned phrase '{_CMD_PHRASE}'"):
            issue_primary_envelope(
                plan_id="plan-1", round_number=2,
                must_satisfy=[{"id": "MS-1", "description": f"Patch the store {_CMD_PHRASE}."}],
                evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["aria-kernel/**"], base_dir=self.tools,
            )
        self.assertEqual([row for row in self.requests() if row["role"] == "primary_plan"], [])


if __name__ == "__main__":
    unittest.main()
