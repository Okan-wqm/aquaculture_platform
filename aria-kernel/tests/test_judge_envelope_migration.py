"""Tests for the Plan 016 Faz C4 judge envelope migration.

Each existing ARIA judge now consumes `aria/agent-request/v1` and emits
`aria/agent-response/v1`. This test asserts:

- the five judge roles are in REQUEST_ROLES;
- a valid envelope can be built for each role;
- validate_request passes for each;
- a valid response with the matching role passes validate_response (with
  cross-check against the request);
- the existing judge .md files declare the right `name` for the matching
  role (so kernel-side dispatch from role -> target_agent is unambiguous).
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.agent_contract import (
    REQUEST_ROLES,
    REQUEST_SCHEMA,
    RESPONSE_SCHEMA,
    validate_request,
    validate_response,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
JUDGE_DIR = REPO_ROOT / ".claude" / "agents"

# Mapping: judge agent name -> request role used when invoking it.
JUDGE_ROLE_MAP = {
    "aria-evidence-judge": "evidence_judgment",
    "aria-adversarial-judge": "adversarial_judgment",
    "aria-consensus-arbiter": "consensus_arbitration",
    "aria-change-intelligence": "change_intelligence",
    "aria-goldset-curator": "goldset_curation",
}


def _make_envelope_pair(*, judge_name: str, role: str):
    request = {
        "$schema": REQUEST_SCHEMA,
        "request_id": f"req-judge-{judge_name}-001",
        "cycle_id": "aria-test-cycle",
        "role": role,
        "target_agent": judge_name,
        "evidence_refs": ["docs/aria/SPEC.md:53"],
        "allowed_scope": ["aria-kernel/**"],
        "forbidden_scope": ["secrets/**", "infrastructure/**"],
        "must_satisfy": [
            {
                "id": "MS-1",
                "statement": (
                    f"Validate the supplied claim using only the provided evidence "
                    f"refs and emit the {role} response shape."
                ),
            }
        ],
        "validation_commands": [],
        "expected_output_path": (
            f"aria-tools/agent-invocations/results/{judge_name}-001.json"
        ),
    }
    response = {
        "$schema": RESPONSE_SCHEMA,
        "request_id": request["request_id"],
        "claim_id": "claim_test-judge-001",
        "agent_id": judge_name,
        "role": role,
        "status": "submitted",
        "satisfaction_matrix": [
            {"id": "MS-1", "verdict": "satisfied"},
        ],
        "output_path": request["expected_output_path"],
    }
    return request, response


class JudgeRoleEnumTests(unittest.TestCase):
    def test_all_five_judge_roles_present(self) -> None:
        for role in JUDGE_ROLE_MAP.values():
            self.assertIn(role, REQUEST_ROLES)


class JudgeEnvelopeRoundTripTests(unittest.TestCase):
    def test_each_judge_role_passes_request_validation(self) -> None:
        for name, role in JUDGE_ROLE_MAP.items():
            with self.subTest(judge=name, role=role):
                request, _ = _make_envelope_pair(judge_name=name, role=role)
                validate_request(request)

    def test_each_judge_role_passes_response_validation_against_request(self) -> None:
        for name, role in JUDGE_ROLE_MAP.items():
            with self.subTest(judge=name, role=role):
                request, response = _make_envelope_pair(judge_name=name, role=role)
                validate_response(response, request=request)


class JudgeAgentFileInvariantTests(unittest.TestCase):
    """The judge .md file's frontmatter `name` must match the role mapping."""

    def test_each_judge_md_declares_expected_name(self) -> None:
        for name in JUDGE_ROLE_MAP:
            path = JUDGE_DIR / f"{name}.md"
            self.assertTrue(path.exists(), f"missing {path}")
            text = path.read_text(encoding="utf-8")
            match = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
            self.assertIsNotNone(match, f"{path}: name field missing")
            assert match is not None  # for type-checker
            self.assertEqual(match.group(1).strip(), name)

    def test_each_judge_md_documents_envelope_contract(self) -> None:
        for name in JUDGE_ROLE_MAP:
            path = JUDGE_DIR / f"{name}.md"
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                "Plan 016 Envelope Contract",
                text,
                f"{name}: missing Plan 016 Envelope Contract section",
            )
            self.assertIn(
                "aria/agent-request/v1",
                text,
                f"{name}: must reference the request schema",
            )
            self.assertIn(
                "aria/agent-response/v1",
                text,
                f"{name}: must reference the response schema",
            )
            self.assertIn(
                "satisfaction_matrix",
                text,
                f"{name}: must reference the satisfaction matrix",
            )

    def test_each_judge_md_declares_role_value(self) -> None:
        for name, role in JUDGE_ROLE_MAP.items():
            path = JUDGE_DIR / f"{name}.md"
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                f'role: "{role}"',
                text,
                f"{name}: must declare role: \"{role}\"",
            )


if __name__ == "__main__":
    unittest.main()
