"""ARIA-HIGH-002 — the typed executor failure contract (Task 4).

The baseline drain produced 25 mostly unclassified ``claude_cli_exit_1``
failures: every perimeter condition collapsed into one exit code, so no
ledger, breaker, or operator could tell an expired session from a missing
CLI from a timeout. These tests pin the closed classification vocabulary,
the retryability policy, the sanitized ``aria/dispatch-result/v1`` child
summary, and the dispatch-route contract before any executor is wired.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

# tools/aria-poc is not on PYTHONPATH by default — add it (test_ci_executor
# precedent).
_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import claude_runtime  # noqa: E402
import dispatch_failure  # noqa: E402
from claude_runtime import ClaudeRunResult  # noqa: E402
from dispatch_failure import (  # noqa: E402
    DISPATCH_FAILURE_CLASSES,
    DispatchFailure,
    DispatchRoute,
    build_dispatch_result_summary,
    classify_dispatch_failure,
    classify_route_mismatch,
    resolve_dispatch_route,
)

_DETAIL_CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")


def _result(
    *,
    returncode: int = 0,
    refusal: dict | None = None,
    auth_failure: dict | None = None,
    credit_exhaustion: dict | None = None,
) -> ClaudeRunResult:
    return ClaudeRunResult(
        returncode=returncode,
        stdout="",
        stderr="",
        final_message="",
        usage=None,
        events=(),
        refusal=refusal,
        auth_failure=auth_failure,
        credit_exhaustion=credit_exhaustion,
    )


class ClosedVocabularyTests(unittest.TestCase):
    def test_vocabulary_is_exactly_the_governed_set(self) -> None:
        self.assertEqual(
            list(DISPATCH_FAILURE_CLASSES),
            [
                "cli_unavailable",
                "auth_unavailable",
                "auth_failed",
                "usage_unavailable",
                "credit_exhausted",
                "provider_redirect_unavailable",
                "policy_violation",
                "timeout",
                "response_schema_rejected",
                "process_exit",
                "unknown",
            ],
        )

    def test_failure_rejects_values_outside_the_vocabulary(self) -> None:
        with self.assertRaises(ValueError):
            DispatchFailure(
                failure_class="kind_of_broken",
                retryable=False,
                detail_code="x",
                phase="spawn",
            )

    def test_phase_vocabulary_is_closed(self) -> None:
        with self.assertRaises(ValueError):
            DispatchFailure(
                failure_class="timeout",
                retryable=True,
                detail_code="x",
                phase="somewhere",
            )
        with self.assertRaises(ValueError):
            classify_dispatch_failure(
                exception=claude_runtime.ClaudeCliUnavailable("x"),
                phase="bogus",
            )


class ExceptionClassificationTests(unittest.TestCase):
    def test_perimeter_exceptions_classify_non_retryable(self) -> None:
        cases = [
            (claude_runtime.ClaudeCliUnavailable, "cli_unavailable"),
            (claude_runtime.ClaudeAuthUnavailable, "auth_unavailable"),
            (claude_runtime.ClaudeAuthFailure, "auth_failed"),
            (claude_runtime.ClaudeUsageUnavailable, "usage_unavailable"),
            (claude_runtime.ClaudeCreditExhausted, "credit_exhausted"),
            (claude_runtime.ProviderRedirectUnavailable, "provider_redirect_unavailable"),
            (claude_runtime.ClaudePolicyViolation, "policy_violation"),
        ]
        for exc_type, expected_class in cases:
            with self.subTest(expected_class=expected_class):
                failure = classify_dispatch_failure(
                    exception=exc_type("named_cause_token"),
                    phase="preflight",
                )
                self.assertIsNotNone(failure)
                assert failure is not None  # for the type checker's sake
                self.assertEqual(failure.failure_class, expected_class)
                self.assertFalse(failure.retryable)
                self.assertEqual(failure.phase, "preflight")

    def test_timeout_is_retryable_within_bounded_policy(self) -> None:
        failure = classify_dispatch_failure(
            exception=subprocess.TimeoutExpired(cmd="claude", timeout=600),
            phase="runtime",
        )
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.failure_class, "timeout")
        self.assertTrue(failure.retryable)

    def test_unknown_exception_falls_to_unknown(self) -> None:
        failure = classify_dispatch_failure(
            exception=RuntimeError("something novel"),
            phase="spawn",
        )
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.failure_class, "unknown")


class ResultClassificationTests(unittest.TestCase):
    def test_clean_success_classifies_as_none(self) -> None:
        self.assertIsNone(
            classify_dispatch_failure(result=_result(), phase="runtime")
        )

    def test_model_refusal_is_not_a_failure(self) -> None:
        self.assertIsNone(
            classify_dispatch_failure(
                result=_result(refusal={"category": "safety"}),
                phase="runtime",
            )
        )

    def test_process_exit_is_retryable_within_bounded_policy(self) -> None:
        failure = classify_dispatch_failure(
            result=_result(returncode=1), phase="runtime"
        )
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.failure_class, "process_exit")
        self.assertTrue(failure.retryable)

    def test_result_markers_map_to_typed_failures(self) -> None:
        auth = classify_dispatch_failure(
            result=_result(auth_failure={"matched_marker": "session expired"}),
            phase="runtime",
        )
        self.assertIsNotNone(auth)
        assert auth is not None
        self.assertEqual(auth.failure_class, "auth_failed")
        self.assertFalse(auth.retryable)

        credit = classify_dispatch_failure(
            result=_result(credit_exhaustion={"matched_marker": "usage limit"}),
            phase="runtime",
        )
        self.assertIsNotNone(credit)
        assert credit is not None
        self.assertEqual(credit.failure_class, "credit_exhausted")
        self.assertFalse(credit.retryable)


class SanitizationTests(unittest.TestCase):
    def test_detail_code_never_carries_stderr_or_token_material(self) -> None:
        exc = claude_runtime.ClaudeCliUnavailable(
            "claude_spawn_failed: stderr='Traceback ... sk-ANTHROPIC-abc123XYZ "
            "raw greek \u03c0\u03c0 ... second line'"
        )
        failure = classify_dispatch_failure(exception=exc, phase="spawn")
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertRegex(failure.detail_code, _DETAIL_CODE_PATTERN.pattern)
        blob = json.dumps(asdict(failure))
        self.assertNotIn("sk-ANTHROPIC", blob)
        self.assertNotIn("Traceback", blob)
        self.assertNotIn("stderr", blob)

    def test_request_id_is_validated_against_output_injection(self) -> None:
        route = DispatchRoute(
            provider="anthropic",
            model="opus",
            role="implementation",
            target_agent="aria-implementer",
        )
        with self.assertRaises(ValueError):
            build_dispatch_result_summary(
                route=route,
                request_id="AIR-1\nmalicious_output=injected",
                outcome="failed",
                failure=None,
                exit_code=None,
            )


class SummaryWireShapeTests(unittest.TestCase):
    def _route(self) -> DispatchRoute:
        return DispatchRoute(
            provider="anthropic",
            model="opus",
            role="implementation",
            target_agent="aria-implementer",
        )

    def test_wire_shape_is_exactly_the_v1_contract(self) -> None:
        summary = build_dispatch_result_summary(
            route=self._route(),
            request_id="AIR-2026-001",
            outcome="succeeded",
            failure=None,
            exit_code=0,
        )
        self.assertEqual(
            set(summary),
            {
                "$schema",
                "schema_version",
                "request_id",
                "role",
                "target_agent",
                "provider",
                "model",
                "outcome",
                "failure_class",
                "retryable",
                "failure_detail_code",
                "exit_code",
            },
        )
        self.assertEqual(summary["$schema"], "aria/dispatch-result/v1")
        self.assertEqual(summary["schema_version"], 1)
        self.assertEqual(summary["outcome"], "succeeded")
        self.assertIsNone(summary["failure_class"])
        self.assertFalse(summary["retryable"])
        self.assertIsNone(summary["failure_detail_code"])
        self.assertEqual(summary["exit_code"], 0)

    def test_failed_outcome_carries_the_typed_failure(self) -> None:
        failure = DispatchFailure(
            failure_class="timeout",
            retryable=True,
            detail_code="subprocess_timeout",
            phase="runtime",
        )
        summary = build_dispatch_result_summary(
            route=self._route(),
            request_id="AIR-2026-002",
            outcome="failed",
            failure=failure,
            exit_code=None,
        )
        self.assertEqual(summary["outcome"], "failed")
        self.assertEqual(summary["failure_class"], "timeout")
        self.assertTrue(summary["retryable"])
        self.assertEqual(summary["failure_detail_code"], "subprocess_timeout")

    def test_outcome_vocabulary_is_succeeded_failed_refused(self) -> None:
        for outcome in ("succeeded", "failed", "refused"):
            summary = build_dispatch_result_summary(
                route=self._route(),
                request_id="AIR-2026-003",
                outcome=outcome,
                failure=None,
                exit_code=None,
            )
            self.assertEqual(summary["outcome"], outcome)
        with self.assertRaises(ValueError):
            build_dispatch_result_summary(
                route=self._route(),
                request_id="AIR-2026-003",
                outcome="crashed",
                failure=None,
                exit_code=None,
            )


class RouteTests(unittest.TestCase):
    def test_default_anthropic_route_resolves_byte_identical(self) -> None:
        request = {"target_agent": "aria-implementer", "role": "implementation"}
        with patch.object(dispatch_failure, "resolve_claude_model", return_value="opus"):
            route = resolve_dispatch_route(request=request, repo_root=_REPO_ROOT)
        self.assertEqual(
            (route.provider, route.model, route.role, route.target_agent),
            ("anthropic", "opus", "implementation", "aria-implementer"),
        )

    def test_redirected_model_resolves_the_redirect_provider(self) -> None:
        request = {"target_agent": "aria-adversarial-judge", "role": "judge"}
        with patch.object(dispatch_failure, "resolve_claude_model", return_value="glm-5.3"):
            route = resolve_dispatch_route(request=request, repo_root=_REPO_ROOT)
        self.assertEqual(route.provider, "zai")
        self.assertEqual(route.model, "glm-5.3")

    def test_missing_target_agent_fails_closed(self) -> None:
        with self.assertRaises(ValueError):
            resolve_dispatch_route(request={"role": "implementation"}, repo_root=_REPO_ROOT)

    def test_route_mismatch_is_a_classified_contract_failure(self) -> None:
        predicted = DispatchRoute(
            provider="anthropic",
            model="opus",
            role="implementation",
            target_agent="aria-implementer",
        )
        executed = DispatchRoute(
            provider="zai",
            model="glm-5.3",
            role="implementation",
            target_agent="aria-implementer",
        )
        failure = classify_route_mismatch(predicted=predicted, executed=executed)
        self.assertIsNotNone(failure)
        assert failure is not None
        self.assertEqual(failure.failure_class, "policy_violation")
        self.assertEqual(failure.detail_code, "dispatch_route_mismatch")
        self.assertFalse(failure.retryable)
        self.assertIsNone(classify_route_mismatch(predicted=predicted, executed=predicted))


class RunResultCompatibilityTests(unittest.TestCase):
    def test_legacy_construction_is_unchanged_and_defaults_are_none(self) -> None:
        result = ClaudeRunResult(
            returncode=0,
            stdout="",
            stderr="",
            final_message="done",
            usage=None,
            events=(),
        )
        self.assertIsNone(result.failure_class)
        self.assertIsNone(result.retryable)
        self.assertIsNone(result.failure_detail_code)

    def test_extended_fields_round_trip_and_stay_frozen(self) -> None:
        result = ClaudeRunResult(
            returncode=1,
            stdout="",
            stderr="",
            final_message="",
            usage=None,
            events=(),
            failure_class="process_exit",
            retryable=True,
            failure_detail_code="claude_exit_1",
        )
        self.assertEqual(result.failure_class, "process_exit")
        with self.assertRaises(Exception):
            result.failure_class = "timeout"  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
