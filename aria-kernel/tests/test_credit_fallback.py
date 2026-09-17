"""Credit exhaustion is terminal on every tier; auth failover is role-conditioned.

Operator decision 2026-09-12 ("sadece opus", plus the delegation of the same
day): ARIA never downgrades a decision or an implementation to a weaker
tier. Credit exhaustion is a PROVIDER-level fact — for read-only roles the
fleet answers it by cooling the provider and admitting the next vendor; for
write-scope roles (implementer, worker), which only the managed Claude route
can run, an exhausted opus REQUEUES the request and it is retried when opus
is back. What this module pins, behaviourally, through the SSoT helper
``claude_runtime.run_with_model_fallback`` with a scripted fake ``run``:

* A credit exhaustion on ANY tier makes exactly one call, fires the audit
  hook, and raises ``ClaudeCreditExhausted`` naming the provider and model —
  there is no sonnet (or any) retry, and no fable entry anywhere.
* A refusal is returned on the result (the executors escalate it); it is
  not retried on another tier.
* ARIA-HIGH-023 survives as an AUTH-only, cross-vendor rung: a read-only
  role's dead credential retries once on the other vendor; a write-scope
  role's does not, because the other vendors' runtimes are read-only — and
  that condition is read from the fleet row, not from prose.
* The executors are pinned (AST) to hand the helper the profile's own
  ``write_capable`` fact and to release a credit-exhausted claim under the
  provider-naming reason.

Detection (extract_credit_exhaustion) is unit-tested separately in
test_claude_runtime_contract.CreditExhaustionDetectionTests; the native
cooldown and the requeue live in test_provider_quota_cooldown and
test_ci_executor_native_claude.
"""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import claude_runtime  # noqa: E402
from claude_runtime import (  # noqa: E402
    AUTH_FAILOVER_TIER,
    ClaudeAuthFailure,
    ClaudeCreditExhausted,
    ClaudeRunResult,
    _cross_provider_auth_fallback,
    run_with_model_fallback,
)

_CI_SOURCE = (_POC / "ci_executor.py").read_text(encoding="utf-8")
_WORKER_SOURCE = (_POC / "worker_executor.py").read_text(encoding="utf-8")


def _result(*, credit=None, refusal=None, auth=None, tag="") -> ClaudeRunResult:
    return ClaudeRunResult(
        returncode=0 if (credit is None and auth is None) else 1,
        stdout=tag,
        stderr="",
        final_message=tag,
        usage={} if credit is None else None,
        events=(),
        refusal=refusal,
        credit_exhaustion=credit,
        auth_failure=auth,
    )


class _CreditAudit:
    """Records every ``on_credit(model, record)`` call as (model, record)."""

    def __init__(self) -> None:
        self.seen: list[tuple[str, dict]] = []

    def __call__(self, model: str, record: dict) -> None:
        self.seen.append((model, record))


class _ScriptedRun:
    """Returns the i-th scripted result on the i-th call, recording (model, effort)."""

    def __init__(self, *results: ClaudeRunResult) -> None:
        self._results = list(results)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, model: str, effort: str) -> ClaudeRunResult:
        self.calls.append((model, effort))
        return self._results[len(self.calls) - 1]


class TheLadderStatesTheDecisionAsData(unittest.TestCase):
    def test_no_in_vendor_credit_rung_exists(self) -> None:
        """The old map had fable -> opus and opus -> sonnet. Neither name may
        appear as a key OR a value: sonnet is not a rung and fable is selected
        by nothing (tests/invariants/test_fable_is_selected_by_nothing)."""
        names = set(AUTH_FAILOVER_TIER) | set(AUTH_FAILOVER_TIER.values())
        self.assertFalse(names & {"sonnet", "haiku", "fable"}, names)
        self.assertEqual(AUTH_FAILOVER_TIER, {"opus": "glm-5.3", "glm-5.3": "opus"})
        for primary, target in AUTH_FAILOVER_TIER.items():
            with self.subTest(primary=primary):
                self.assertNotEqual(primary, target, "a tier cannot fail over to itself")
                # Every rung crosses a vendor: an in-vendor rung would be a
                # downgrade wearing the auth ladder's name.
                self.assertNotEqual(claude_runtime._model_provider(primary),
                                    claude_runtime._model_provider(target))

    def test_the_old_ladder_names_are_gone(self) -> None:
        """MODEL_FALLBACK_TIER and CREDIT_FALLBACK_EFFORT had one reader each
        (the credit retry); with the retry gone they would be dead data that
        still LOOKS like policy."""
        for name in ("MODEL_FALLBACK_TIER", "CREDIT_FALLBACK_EFFORT"):
            with self.subTest(name=name):
                with self.assertRaises(AttributeError):
                    getattr(claude_runtime, name)
        for source_name, source in (("ci_executor", _CI_SOURCE), ("worker_executor", _WORKER_SOURCE)):
            with self.subTest(source=source_name):
                self.assertNotIn("MODEL_FALLBACK_TIER", source)
                self.assertNotIn("CREDIT_FALLBACK_EFFORT", source)
                # The old ladder's `on_refusal` key, as an identifier — not a
                # substring of an unrelated name like `delivery_admission_refusal`
                # (ARIA-HIGH-124's delivery admission, which legitimately reads
                # here). A word boundary is what "the name is gone" means.
                self.assertNotRegex(source, r"(?<![A-Za-z0-9_])on_refusal(?![A-Za-z0-9_])")


class CreditExhaustionIsTerminalOnEveryTier(unittest.TestCase):
    def test_an_exhausted_opus_raises_after_exactly_one_call(self) -> None:
        """The rung the operator removed: opus + credit used to retry sonnet@max."""
        credit = {"matched_marker": "usage-credits", "returncode": 0}
        run = _ScriptedRun(_result(credit=credit, tag="opus"), _result(tag="sonnet-must-never-run"))
        audit = _CreditAudit()
        for write_capable in (True, False):
            run.calls.clear()
            audit.seen.clear()
            with self.subTest(write_capable=write_capable):
                with self.assertRaises(ClaudeCreditExhausted) as raised:
                    run_with_model_fallback(
                        run=run, model="opus", effort="max", write_capable=write_capable,
                        on_credit=audit,
                    )
                self.assertEqual(run.calls, [("opus", "max")])
                self.assertEqual(audit.seen, [("opus", credit)], "the audit hook fires before the raise")
                self.assertEqual((raised.exception.provider, raised.exception.model), ("anthropic", "opus"))
                self.assertEqual(raised.exception.detail, credit)
                self.assertIn("anthropic", str(raised.exception))

    def test_an_exhausted_glm_names_zai(self) -> None:
        run = _ScriptedRun(_result(credit={"matched_marker": "quota exceeded"}, tag="glm-5.3"))
        with self.assertRaises(ClaudeCreditExhausted) as raised:
            run_with_model_fallback(run=run, model="glm-5.3", effort="medium", write_capable=False)
        self.assertEqual(run.calls, [("glm-5.3", "medium")])
        self.assertEqual((raised.exception.provider, raised.exception.model), ("zai", "glm-5.3"))

    def test_credit_takes_precedence_over_refusal(self) -> None:
        # A result carrying BOTH signals is a quota fact first: raised, not
        # returned as a refusal for the executor to escalate.
        run = _ScriptedRun(
            _result(credit={"matched_marker": "billing"}, refusal={"category": "x"}, tag="opus"),
        )
        audit = _CreditAudit()
        with self.assertRaises(ClaudeCreditExhausted):
            run_with_model_fallback(run=run, model="opus", effort="high", write_capable=True, on_credit=audit)
        self.assertEqual(len(run.calls), 1)
        self.assertEqual(len(audit.seen), 1)

    def test_the_exception_requires_its_provider_identity(self) -> None:
        """The release reason and the cooldown are keyed on the provider; an
        exception without one would force the executor to guess."""
        with self.assertRaises(TypeError):
            ClaudeCreditExhausted("no provider")  # type: ignore[call-arg]


class RefusalIsReturnedNotRetried(unittest.TestCase):
    def test_a_refusal_rides_the_result_after_one_call(self) -> None:
        refusal = {"category": "cyber"}
        run = _ScriptedRun(_result(refusal=refusal, tag="opus-refused"), _result(tag="never"))
        out = run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)
        self.assertEqual(run.calls, [("opus", "high")])
        self.assertEqual(out.refusal, refusal)
        self.assertEqual(out.final_message, "opus-refused")

    def test_a_clean_run_passes_through(self) -> None:
        run = _ScriptedRun(_result(tag="opus-clean"))
        out = run_with_model_fallback(run=run, model="opus", effort="high", write_capable=True)
        self.assertEqual(run.calls, [("opus", "high")])
        self.assertEqual(out.final_message, "opus-clean")


class AuthFailoverIsCrossVendorAndRoleConditioned(unittest.TestCase):
    """ARIA-HIGH-023 — an auth failure is a fact about the vendor's credential."""

    def test_a_read_only_role_retries_once_on_the_other_vendor(self) -> None:
        run = _ScriptedRun(
            _result(auth={"marker": "invalid api key", "remedy": "login"}, tag="opus"),
            _result(tag="glm-5.3"),
        )
        out = run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)
        self.assertEqual(run.calls, [("opus", "high"), ("glm-5.3", "high")])
        self.assertEqual(out.final_message, "glm-5.3")

    def test_a_read_only_role_on_glm_retries_on_opus(self) -> None:
        run = _ScriptedRun(
            _result(auth={"marker": "unauthorized", "remedy": "key"}, tag="glm-5.3"),
            _result(tag="opus"),
        )
        out = run_with_model_fallback(run=run, model="glm-5.3", effort="medium", write_capable=False)
        self.assertEqual(run.calls, [("glm-5.3", "medium"), ("opus", "medium")])
        self.assertEqual(out.final_message, "opus")

    def test_a_write_scope_role_is_never_retried_cross_vendor(self) -> None:
        """The other vendors' runtimes are read-only (fleet row
        `admits_writes`): an implementer handed to glm could not write a
        line. The failure is terminal at once, and says why."""
        run = _ScriptedRun(
            _result(auth={"marker": "oauth session expired", "remedy": "re-authenticate"}, tag="opus"),
            _result(tag="glm-must-never-run"),
        )
        with self.assertRaises(ClaudeAuthFailure) as raised:
            run_with_model_fallback(run=run, model="opus", effort="max", write_capable=True)
        self.assertEqual(run.calls, [("opus", "max")])
        self.assertIn("write-scope", str(raised.exception))
        self.assertIn("re-authenticate", str(raised.exception))

    def test_the_role_condition_is_read_from_the_fleet_row(self) -> None:
        """Not a literal list of provider names in claude_runtime: the walk
        asks the fleet whether the rung's provider admits writes."""
        from aria_kernel.model_fleet import provider_admits_writes

        self.assertTrue(provider_admits_writes("anthropic"))
        self.assertFalse(provider_admits_writes("zai"))
        self.assertFalse(provider_admits_writes("openai"))
        self.assertFalse(provider_admits_writes("nobody"), "an unlisted provider admits nothing")
        self.assertEqual(_cross_provider_auth_fallback("opus", write_capable=False), "glm-5.3")
        self.assertIsNone(_cross_provider_auth_fallback("opus", write_capable=True))
        # glm -> opus is admissible for a writer too: anthropic admits writes.
        self.assertEqual(_cross_provider_auth_fallback("glm-5.3", write_capable=True), "opus")
        self.assertIsNone(_cross_provider_auth_fallback("haiku", write_capable=False))
        # The walk is a cycle (opus -> glm-5.3 -> opus) and must terminate.
        for start in AUTH_FAILOVER_TIER:
            with self.subTest(walk_from=start):
                resolved = _cross_provider_auth_fallback(start, write_capable=False)
                self.assertIsNotNone(resolved)
                self.assertNotEqual(resolved, start)

    def test_both_vendors_failing_auth_is_terminal_and_names_both(self) -> None:
        run = _ScriptedRun(
            _result(auth={"marker": "invalid api key", "remedy": "login"}, tag="opus"),
            _result(auth={"marker": "unauthorized", "remedy": "zai key"}, tag="glm-5.3"),
        )
        with self.assertRaises(ClaudeAuthFailure) as raised:
            run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False)
        message = str(raised.exception)
        self.assertIn("opus", message)
        self.assertIn("glm-5.3", message)
        self.assertIn("both providers", message)
        self.assertEqual(len(run.calls), 2)

    def test_the_failover_attempt_own_exhaustion_names_that_vendor(self) -> None:
        """opus dead credential -> glm quota exhausted: the exhausted provider
        is zai, and that is what the release and the cooldown must be keyed on."""
        run = _ScriptedRun(
            _result(auth={"marker": "invalid api key", "remedy": "login"}, tag="opus"),
            _result(credit={"matched_marker": "quota exceeded"}, tag="glm-dry"),
        )
        audit = _CreditAudit()
        with self.assertRaises(ClaudeCreditExhausted) as raised:
            run_with_model_fallback(run=run, model="opus", effort="high", write_capable=False,
                                    on_credit=audit)
        self.assertEqual(len(run.calls), 2)
        self.assertEqual((raised.exception.provider, raised.exception.model), ("zai", "glm-5.3"))
        # The audit names the tier that actually ran out, not the primary.
        self.assertEqual([model for model, _ in audit.seen], ["glm-5.3"])


def _function(tree: ast.Module, name: str) -> ast.FunctionDef:
    return next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)


def _helper_calls(tree: ast.AST) -> list[ast.Call]:
    return [node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "run_with_model_fallback"]


class ExecutorWiringPins(unittest.TestCase):
    """Both executors route through the helper and hand it the profile's fact."""

    def _assert_helper_call_shape(self, source: str, *, profile_name: str) -> None:
        tree = ast.parse(source)
        calls = _helper_calls(tree)
        self.assertEqual(len(calls), 1, "exactly one helper call per executor")
        keywords = {keyword.arg: keyword.value for keyword in calls[0].keywords}
        self.assertEqual(set(keywords), {"run", "model", "effort", "write_capable", "on_credit"})
        # `write_capable=<profile>.write_capable` — the profile SSoT's own
        # property, not a literal and not a re-derivation from the tools list.
        write_capable = keywords["write_capable"]
        self.assertIsInstance(write_capable, ast.Attribute)
        self.assertEqual(write_capable.attr, "write_capable")
        self.assertIsInstance(write_capable.value, ast.Name)
        self.assertEqual(write_capable.value.id, profile_name)

    def test_ci_executor_hands_the_helper_the_profile_fact(self) -> None:
        self._assert_helper_call_shape(_CI_SOURCE, profile_name="agent_profile")
        self.assertIn('"model_credit_exhausted"', _CI_SOURCE)

    def test_worker_executor_hands_the_helper_the_profile_fact(self) -> None:
        self._assert_helper_call_shape(_WORKER_SOURCE, profile_name="profile")
        self.assertIn("model_credit_exhausted assignment=", _WORKER_SOURCE)

    def test_the_worker_arm_covers_the_two_terminal_runtime_facts(self) -> None:
        """ClaudeCreditExhausted and ClaudeAuthFailure used to escape
        worker_executor.main() as a traceback; the non-zero exit is the whole
        release protocol there, so the arm must classify and return 1."""
        tree = ast.parse(_WORKER_SOURCE)
        handlers = [node for node in ast.walk(_function(tree, "main")) if isinstance(node, ast.ExceptHandler)]
        covered: set[str] = set()
        for handler in handlers:
            names = [node.id for node in ast.walk(handler.type) if isinstance(node, ast.Name)] if handler.type else []
            covered.update(names)
        self.assertLessEqual({"ClaudeCreditExhausted", "ClaudeAuthFailure"}, covered, covered)


class CreditExhaustionReleasesTheClaimAsRequeued(unittest.TestCase):
    """ORPHAN-HIGH-489 kept, and sharpened: the arm is the credit arm alone.

    A quota exhaustion is released under a reason that names the PROVIDER
    (``provider_quota_unavailable:<provider>``) — a harness-fault prefix, so
    the request derives REQUEUED without burning its budget — and, on the
    native lane, the provider cooldown is recorded before the release.
    Node-shape, not text (Plan 026R §H.1): a string match passes on a handler
    that was commented out.
    """

    def _credit_handler(self) -> ast.ExceptHandler:
        tree = ast.parse(_CI_SOURCE)
        handlers = [node for node in ast.walk(_function(tree, "_main"))
                    if isinstance(node, ast.ExceptHandler) and isinstance(node.type, ast.Name)
                    and node.type.id == "ClaudeCreditExhausted"]
        self.assertEqual(len(handlers), 1, "exactly one dedicated credit-exhaustion handler in _main()")
        return handlers[0]

    def test_the_handler_releases_under_the_provider_naming_reason(self) -> None:
        handler = self._credit_handler()
        releases = [node for node in ast.walk(handler) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "_release_claim"]
        self.assertEqual(len(releases), 1)
        reason = next(keyword.value for keyword in releases[0].keywords if keyword.arg == "reason")
        self.assertIsInstance(reason, ast.JoinedStr, "the reason is parameterised by the provider")
        head = reason.values[0]
        self.assertIsInstance(head, ast.Constant)
        self.assertEqual(head.value, "provider_quota_unavailable:")
        placeholder = next(node for node in reason.values if isinstance(node, ast.FormattedValue))
        self.assertIsInstance(placeholder.value, ast.Attribute)
        self.assertEqual(placeholder.value.attr, "provider")

    def test_the_handler_records_the_provider_cooldown_before_releasing(self) -> None:
        handler = self._credit_handler()
        statements = [ast.dump(node) for node in handler.body]
        cooldown_index = next(i for i, text in enumerate(statements) if "record_provider_cooldown" in text)
        release_index = next(i for i, text in enumerate(statements) if "_release_claim" in text)
        self.assertLess(cooldown_index, release_index, "cool the provider, then hand the claim back")
        cooldown_call = next(node for node in ast.walk(handler.body[cooldown_index]) if isinstance(node, ast.Call)
                             and isinstance(node.func, ast.Name) and node.func.id == "record_provider_cooldown")
        keywords = {keyword.arg for keyword in cooldown_call.keywords}
        self.assertLessEqual({"provider", "model", "cooldown_seconds", "request_id", "claim_id", "detection"}, keywords)
        seconds = next(keyword.value for keyword in cooldown_call.keywords if keyword.arg == "cooldown_seconds")
        # The one duration is the policy's — not a literal here.
        self.assertIsInstance(seconds, ast.Attribute)
        self.assertEqual(seconds.attr, "provider_cooldown_seconds")

    def test_the_reason_is_a_harness_fault_the_kernel_owns(self) -> None:
        from aria_kernel.agent_invocations import classify_release_reason
        from aria_kernel.release_reason import RELEASE_REASON_CODES, parse_release_reason

        self.assertEqual(classify_release_reason("provider_quota_unavailable:anthropic"), "harness")
        parsed = parse_release_reason("provider_quota_unavailable:zai")
        self.assertEqual((parsed.reason_code, parsed.reason_detail, parsed.fault_domain),
                         ("PROVIDER_QUOTA_UNAVAILABLE", "zai", "harness"))
        self.assertIn("PROVIDER_QUOTA_UNAVAILABLE", RELEASE_REASON_CODES)

    def test_the_exception_is_imported_not_shadowed(self) -> None:
        """A NameError here would make the except arm unreachable at runtime
        while the AST assertion above still passed."""
        header = _CI_SOURCE[: _CI_SOURCE.index("except ClaudeCreditExhausted as exc:")]
        self.assertIn("ClaudeCreditExhausted,", header)


if __name__ == "__main__":
    unittest.main()
