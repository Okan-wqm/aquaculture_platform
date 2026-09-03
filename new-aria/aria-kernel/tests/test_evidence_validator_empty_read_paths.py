"""Plan 023 v3 §C-2 — empty read_paths bypass + output_schema enforcement.

Pre-Plan-023 evidence_validator.py:67 + :81 used a truthiness check on
`declared_read_paths` (a derived set) to gate the subset enforcement
loop:

    if isinstance(ref, dict) and ... and declared_read_paths:

When `read_paths == []`, the derived set was empty and the gate was
falsy, skipping the subset check entirely. A tool emitting findings
with read_paths=[] passed evidence validation regardless of where the
finding pointed.

Plus a layered defense gap: read_paths is a load-bearing runtime field
for scope-out detection (C-1) and read-coverage audits, but the
registration-time check did not enforce that every tool declare
read_paths in its output_schema.required. A tool author could ship
output_schema.required without read_paths and the runtime bypass at
:67 / :81 would never fire because read_paths was simply absent from
the envelope.

Plus the runtime parser at tool_runner._parse_tool_output silently
returned None for any payload missing required fields, losing the
specific reason — the runner envelope only knew "schema_error",
operator audit lost the field-name signal.

Plan 023 v3 §C-2 fixes all three layers:

1. evidence_validator: distinguish "read_paths not present" (None) from
   "read_paths declared empty" ([]). Empty list still triggers subset
   enforcement; any evidence ref with a path is rejected.
2. tool_registry._validate_output_schema: enforce that
   output_schema.required contains "read_paths" for every tool.
3. tool_runner._parse_tool_output: return (payload, error_code) tuple.
   Error codes are a closed vocabulary (output_not_json, output_not_dict,
   missing_field:<field>, field_not_list:<field>, etc.). The runner
   envelope carries runner.parse_error so observability can see the
   specific failure reason.
"""
from __future__ import annotations

import unittest

from aria_kernel.evidence_validator import validate_tool_output_evidence
from aria_kernel.tool_registry import GovernanceError, validate_tool_definition
from aria_kernel.tool_runner import _parse_tool_output


def _make_tool(allowed: list[str] | None = None) -> dict:
    return {
        "tool_id": "fake",
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "owner": "platform",
        "schema_version": 2,
        "claim_types": ["fake"],
        "declared_scope": ["apps/**"],
        "allowed_read_globs": allowed or ["apps/**"],
        "forbidden_read_globs": [".git/**"],
        "fixture_set": "tools/aria-poc/fixtures/fake",
        "health_thresholds": {
            "precision_min": 0.85,
            "non_critical_false_positives_30d": 3,
            "critical_false_positives": 0,
            "crash_rate_last_10": 0.2,
        },
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "runner": {
            "type": "subprocess",
            "argv": ["python3", "fake.py"],
            "cwd": "tools/aria-poc",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
    }


def _make_finding(path: str, line: int = 1) -> dict:
    return {
        "id": "F-1",
        "evidence": [{"path": path, "line": line}],
    }


class EvidenceValidatorEmptyReadPathsTests(unittest.TestCase):
    def test_empty_read_paths_with_empty_evidence_passes(self) -> None:
        """Empty read_paths + empty findings is a valid 'no reads, no
        findings' tool envelope. The new shape check must not regress
        this happy path."""
        output = {
            "read_paths": [],
            "findings": [],
            "evidence_sources": [],
        }
        result = validate_tool_output_evidence(_make_tool(), output, "/tmp")
        self.assertTrue(result["valid"], f"errors: {result['errors']!r}")

    def test_empty_read_paths_with_findings_rejects_subset(self) -> None:
        """Pre-Plan-023 this slipped through: read_paths=[] + finding with
        evidence pointing at apps/x.ts → declared_read_paths empty set →
        truthiness false → subset check skipped. Plan 023 fix: shape
        check (read_paths is a list, even empty) keeps subset enforcement
        active. Any evidence ref outside the empty set is rejected."""
        output = {
            "read_paths": [],
            "findings": [_make_finding("apps/x.ts")],
            "evidence_sources": [],
        }
        result = validate_tool_output_evidence(_make_tool(), output, "/tmp")
        self.assertFalse(result["valid"])
        self.assertTrue(
            any(err.get("code") == "evidence_outside_declared_read_paths"
                for err in result["errors"]),
            f"expected evidence_outside_declared_read_paths; errors: {result['errors']!r}",
        )

    def test_populated_read_paths_subset_enforcement_unchanged(self) -> None:
        """Existing behavior preserved: read_paths declares apps/a.ts but
        finding evidences apps/b.ts → still rejected (regression guard
        for the existing happy path of the subset check)."""
        output = {
            "read_paths": ["apps/a.ts"],
            "findings": [_make_finding("apps/b.ts")],
            "evidence_sources": [],
        }
        result = validate_tool_output_evidence(_make_tool(), output, "/tmp")
        self.assertFalse(result["valid"])
        self.assertTrue(
            any(err.get("code") == "evidence_outside_declared_read_paths"
                and err.get("path") == "apps/b.ts"
                for err in result["errors"]),
            f"errors: {result['errors']!r}",
        )

    def test_missing_read_paths_field_emits_specific_error(self) -> None:
        """Pre-Plan-023 output.get('read_paths', []) defaulted missing to
        empty list, hiding the case. Plan 023: missing key → explicit
        read_paths_field_missing_in_output error (distinct from empty)."""
        output = {
            # No read_paths key at all.
            "findings": [],
            "evidence_sources": [],
        }
        result = validate_tool_output_evidence(_make_tool(), output, "/tmp")
        self.assertFalse(result["valid"])
        self.assertTrue(
            any(err.get("code") == "read_paths_field_missing_in_output"
                for err in result["errors"]),
            f"errors: {result['errors']!r}",
        )

    def test_observation_only_tool_still_requires_read_paths(self) -> None:
        """A tool that emits no findings but only observations still
        declares what it read. read_paths is a uniform output contract,
        not a findings-conditional requirement."""
        output = {
            "read_paths": [],  # Explicit empty — fine, it read nothing.
            "findings": [],
            "observations": [{"type": "thing", "name": "x"}],
            "evidence_sources": [],
        }
        result = validate_tool_output_evidence(_make_tool(), output, "/tmp")
        self.assertTrue(result["valid"], f"errors: {result['errors']!r}")


class ValidateToolDefinitionRequiresReadPathsTests(unittest.TestCase):
    def test_output_schema_without_read_paths_in_required_rejects(self) -> None:
        """Plan 023 §C-2 layered defense: registration time enforces that
        every tool's output_schema.required contains 'read_paths'. The
        runtime check at :67 / :81 cannot fire if the field is simply
        absent from the envelope; the registration check stops that
        upstream."""
        tool = _make_tool()
        tool["output_schema"] = {
            "type": "object",
            "required": ["observations", "findings", "evidence_sources"],
            # Missing "read_paths".
        }
        with self.assertRaises(GovernanceError) as ctx:
            validate_tool_definition(tool)
        self.assertIn("read_paths", str(ctx.exception))

    def test_output_schema_with_read_paths_in_required_accepts(self) -> None:
        """Regression: tools that DO declare read_paths in required pass
        registration unchanged (Plan 022 baseline behavior)."""
        tool = _make_tool()
        # Default _make_tool already includes read_paths in required.
        validated = validate_tool_definition(tool)
        self.assertIn("read_paths", validated["output_schema"]["required"])


class ParseToolOutputErrorCodeTests(unittest.TestCase):
    def test_valid_payload_returns_payload_and_no_error(self) -> None:
        """Happy path: well-formed JSON output → (payload, None)."""
        tool = _make_tool()
        stdout = '{"observations":[],"findings":[],"read_paths":[],"evidence_sources":[]}'
        payload, error = _parse_tool_output(stdout, tool)
        self.assertIsNotNone(payload)
        self.assertIsNone(error)

    def test_invalid_json_returns_output_not_json(self) -> None:
        """Plan 023 §C-2: parser returns specific error codes so the
        runner envelope carries actionable context."""
        tool = _make_tool()
        payload, error = _parse_tool_output("not json {", tool)
        self.assertIsNone(payload)
        self.assertEqual(error, "output_not_json")

    def test_non_object_payload_returns_output_not_dict(self) -> None:
        tool = _make_tool()
        payload, error = _parse_tool_output("[1, 2, 3]", tool)
        self.assertIsNone(payload)
        self.assertEqual(error, "output_not_dict")

    def test_missing_read_paths_field_returns_specific_code(self) -> None:
        """Runtime envelope without read_paths field surfaces as
        missing_field:read_paths — distinct from generic schema_error."""
        tool = _make_tool()
        stdout = '{"observations":[],"findings":[],"evidence_sources":[]}'
        payload, error = _parse_tool_output(stdout, tool)
        self.assertIsNone(payload)
        self.assertEqual(error, "missing_field:read_paths")

    def test_field_not_list_returns_specific_code(self) -> None:
        tool = _make_tool()
        stdout = '{"observations":"oops","findings":[],"read_paths":[],"evidence_sources":[]}'
        payload, error = _parse_tool_output(stdout, tool)
        self.assertIsNone(payload)
        self.assertEqual(error, "field_not_list:observations")


if __name__ == "__main__":
    unittest.main()
