"""ARIA-HIGH-290 — provider exhaustion is a closed set of signatures, each a cooldown.

Measured 2026-10-01 (runner NLDW4-4-34-28, request
AIR-aria-challenger-planner-83a038b1b7ac and 26 siblings): the managed Claude
session answered every dispatch with "You've hit your weekly limit · resets
6am (UTC)" on exit 1. No marker matched that wording, so each attempt was
classified ``claude_exit_1`` (retryable), the provider was never cooled, and
the drain spent the run re-spawning the same exhausted vendor. The recorded
stderr tail was the CLI's untrusted-workspace notice alone; the cause lived
in the stream's result event and no ledger row carried it.

What this module pins, one property per test, with fake transports only:

* every proven vendor wording (Claude's three limit shapes, its credit and
  auth errors; Z.ai's quota and auth refusals) names a signature from the
  kernel's closed table, and only those shapes do;
* a signature cools its provider, with the reset the message states when it
  states one and the policy's declared default otherwise, bounded;
* the cooldown is written once per transition, not once per request;
* a provider-exhaustion result is never a retryable failure;
* the recorded tail ends with the cause, whatever notice preceded it.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.provider_cooldown import (
    PROVIDER_COOLDOWN_GOVERNANCE_KIND,
    PROVIDER_EXHAUSTION_SIGNATURES,
    active_provider_cooldowns,
    record_provider_cooldown,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

import claude_runtime  # noqa: E402
import zai_runtime  # noqa: E402
from dispatch_failure import classify_dispatch_failure  # noqa: E402

# The exact 2026-10-01 runner output: stderr held only the trust notice, the
# result event held the cause.
_TRUST_NOTICE = (
    "Ignoring 481 permissions.allow entries from .claude/settings.local.json: this workspace has not "
    "been trusted. Run Claude Code interactively here once and accept the trust dialog, or set "
    "projects[\"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform\"]"
    ".hasTrustDialogAccepted: true in /tmp/aria-agent-home/.claude/.claude.json.\n"
)
_WEEKLY_2026_10_01 = "You've hit your weekly limit · resets 6am (UTC)"
_WEEKLY_2026_08_22 = "You've hit your weekly limit · resets Aug 23, 10am (UTC)"
_FABLE_2026_07_03 = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."


def _result_event(text: str, *, is_error: bool = True) -> dict:
    return {"type": "result", "subtype": "success", "is_error": is_error, "result": text}


def _model_said(text: str) -> dict:
    """An assistant frame the MODEL wrote: the API's model id is on it."""
    return {"type": "assistant", "message": {"model": "claude-opus-5", "content": [{"type": "text", "text": text}]}}


def _tool_said(text: str) -> dict:
    """A tool result: bytes a command in the workspace printed, relayed by the CLI."""
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": text}]}}


def _cli_said(text: str, error: str) -> dict:
    """The CLI's own API-error message (CLI 2.1.278, `Eo`/`KDn`): model "<synthetic>", zero
    usage, and the typed `error` the stream-json assistant message carries."""
    return {"type": "assistant", "error": error,
            "message": {"model": "<synthetic>", "content": [{"type": "text", "text": text}]}}


class _Tools(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-exhaustion-signatures-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def _cooldown_rows(self) -> list[dict]:
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        return [row["details"] for row in rows if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]


class ClaudeWordingsNameASignature(unittest.TestCase):
    def test_the_2026_10_01_weekly_limit_is_a_quota_signature_with_its_reset(self) -> None:
        record = claude_runtime.extract_credit_exhaustion(
            returncode=1, stderr=_TRUST_NOTICE, events=(_result_event(_WEEKLY_2026_10_01),),
        )
        self.assertIsNotNone(record, "the 10-01 text must not read as a bare claude_exit_1")
        self.assertEqual(record["signature"], "claude_usage_limit_notice")
        self.assertEqual(record["reset_hint"], _WEEKLY_2026_10_01)

    def test_the_august_weekly_limit_on_a_clean_exit_is_caught_as_content(self) -> None:
        # 2026-08-22: the notice arrived as the assistant's whole answer on exit 0
        # and was sealed as a judge verdict's evidence. It is the CLI's message
        # (model "<synthetic>"), which is why it is read at all (ARIA-HIGH-536).
        record = claude_runtime.extract_credit_exhaustion(
            returncode=0, stderr="", events=(_cli_said(_WEEKLY_2026_08_22, "rate_limit"),),
        )
        self.assertEqual((record["signature"], record["reset_hint"]),
                         ("claude_usage_limit_notice", _WEEKLY_2026_08_22))

    def test_the_july_credit_notice_keeps_its_marker_and_names_its_signature(self) -> None:
        record = claude_runtime.extract_credit_exhaustion(
            returncode=0, stderr="", events=(_cli_said(_FABLE_2026_07_03, "rate_limit"),),
        )
        self.assertEqual((record["signature"], record["matched_marker"]),
                         ("claude_usage_credits_hint", "usage-credits"))

    def test_an_api_credit_error_on_a_failed_run_is_a_quota_signature(self) -> None:
        record = claude_runtime.extract_credit_exhaustion(
            returncode=1, stderr="Error: Your credit balance is too low to run this request.", events=(),
        )
        self.assertEqual(record["signature"], "claude_credit_error")

    def test_an_expired_session_is_an_auth_signature(self) -> None:
        record = claude_runtime.extract_auth_failure(
            returncode=1, stderr="OAuth session expired and could not be refreshed", events=(),
        )
        self.assertEqual(record["signature"], "claude_auth_failure")

    def test_a_plan_discussing_limits_is_not_a_notice(self) -> None:
        plan = ("The planner keeps running when you've hit your weekly limit, because the provider "
                "cooldown routes the request; the sentence is prose, not the CLI's notice line.")
        self.assertIsNone(claude_runtime.extract_credit_exhaustion(
            returncode=0, stderr="", events=(_model_said(plan),),
        ))

    def test_every_claude_signature_is_a_kernel_table_member_for_anthropic(self) -> None:
        for signature in claude_runtime.CLAUDE_EXHAUSTION_SIGNATURES:
            self.assertEqual(PROVIDER_EXHAUSTION_SIGNATURES[signature][0], "anthropic", signature)


def _credit(*, returncode: int, stderr: str = "", events: tuple = ()) -> dict | None:
    return claude_runtime.extract_credit_exhaustion(returncode=returncode, stderr=stderr, events=events)


def _auth(*, returncode: int, stderr: str = "", events: tuple = ()) -> dict | None:
    return claude_runtime.extract_auth_failure(returncode=returncode, stderr=stderr, events=events)


class VendorFactsComeOnlyFromTheClisOwnChannel(unittest.TestCase):
    """ARIA-HIGH-536 — a provider fact (quota, credential) is read only from what the CLI
    itself wrote: its stderr, the terminal ``result`` it marks ``is_error``, and the
    assistant messages it synthesizes for an API error. Never from the model's text or a
    tool's output: this repository has a billing-service, so an agent that writes "billing"
    and then times out would cool Anthropic for the whole fleet and be requeued uncharged."""

    def test_model_text_naming_billing_on_a_timeout_is_no_quota_fact(self) -> None:
        events = (_model_said("Fixing the billing-service invoice handler"),)
        self.assertIsNone(_credit(returncode=124, events=events))

    def test_a_tool_result_saying_not_authenticated_is_no_credential_fact(self) -> None:
        events = (_model_said("Running the auth-service suite."), _tool_said("Error: Not authenticated"))
        self.assertIsNone(_auth(returncode=1, events=events))

    def test_a_model_quoting_the_clis_limit_wording_is_no_quota_fact(self) -> None:
        for returncode, text in (
            (0, "USAGE_LIMIT_MARKERS = ('usage-credits', 'switch models with /model')"),
            (1, f"The fixture reads:\n{_WEEKLY_2026_10_01}\nand the parser takes its reset."),
            (1, "credit balance: the invoice total must not go negative"),
        ):
            with self.subTest(text=text):
                self.assertIsNone(_credit(returncode=returncode, events=(_model_said(text),)))

    def test_the_clis_own_limit_and_credit_messages_are_quota_facts(self) -> None:
        self.assertEqual(_credit(returncode=0, events=(_cli_said(_FABLE_2026_07_03, "rate_limit"),))["signature"],
                         "claude_usage_credits_hint")
        self.assertEqual(_credit(returncode=1, events=(_cli_said(_WEEKLY_2026_10_01, "rate_limit"),))["reset_hint"],
                         _WEEKLY_2026_10_01)
        self.assertEqual(
            _credit(returncode=1, events=(_cli_said("Credit balance is too low", "billing_error"),))["signature"],
            "claude_credit_error")
        self.assertEqual(_credit(returncode=1, stderr="Error: Your credit balance is too low")["signature"],
                         "claude_credit_error")

    def test_the_clis_own_credential_messages_are_credential_facts(self) -> None:
        for stderr, events in (
            ("Failed to authenticate: OAuth session expired and could not be refreshed", ()),
            ("", (_cli_said("Not logged in · Please run /login", "authentication_failed"),)),
            ("", (_result_event("Failed to authenticate. API Error: 401 authentication_error"),)),
        ):
            with self.subTest(stderr=stderr, events=events):
                self.assertEqual(_auth(returncode=1, stderr=stderr, events=events)["signature"],
                                 "claude_auth_failure")


class ZaiRefusalsNameASignature(unittest.TestCase):
    def _run(self, status: int, code: str | None) -> zai_runtime.ZaiRunResult:
        body = json.dumps({"error": {"code": code, "message": "refused"}} if code else {}).encode()

        def opener(request, timeout_seconds):  # noqa: ANN001 — urllib Request
            return zai_runtime.ZaiHttpResponse(status=status, body=body, elapsed_ms=1)

        credential = zai_runtime.ZaiCredential(source="env", location="ARIA_ZAI_API_KEY", _secret="fake")
        return zai_runtime.run_zai_chat(credential, base_url="https://fake.invalid", model="glm-5.3",
                                        system="s", user="u", opener=opener)

    def test_quota_statuses_and_codes_are_the_quota_signature(self) -> None:
        for status, code in ((429, None), (402, None), (400, "1113"), (400, "1302"), (400, "1303"), (400, "1305")):
            with self.subTest(status=status, code=code):
                self.assertEqual(self._run(status, code).exhaustion_signature, "zai_quota_refusal")

    def test_auth_statuses_and_codes_are_the_auth_signature(self) -> None:
        for status, code in ((401, None), (403, None), (400, "1000"), (400, "1002"), (400, "1004")):
            with self.subTest(status=status, code=code):
                self.assertEqual(self._run(status, code).exhaustion_signature, "zai_auth_refusal")

    def test_a_vendor_error_or_a_bad_request_is_no_signature(self) -> None:
        for status in (400, 500, 503):
            self.assertIsNone(self._run(status, None).exhaustion_signature, status)

    def test_both_zai_signatures_are_kernel_table_members_for_zai(self) -> None:
        for signature in ("zai_quota_refusal", "zai_auth_refusal"):
            self.assertEqual(PROVIDER_EXHAUSTION_SIGNATURES[signature][0], "zai")


class ASignatureCoolsItsProvider(_Tools):
    _NOW = datetime(2026, 10, 1, 23, 28, 23, tzinfo=timezone.utc)

    def _record(self, signature: str, *, provider: str = "anthropic", hint: str | None = None,
                now: datetime | None = None, claim: str = "CL-1") -> dict:
        detection = {"signature": signature, **({"reset_hint": hint} if hint else {})}
        return record_provider_cooldown(
            self.tools, provider=provider, model="opus" if provider == "anthropic" else "glm-5.3",
            cooldown_seconds=900, request_id="AIR-1", claim_id=claim, detection=detection,
            now=now or self._NOW,
        )["details"]

    def test_the_stated_reset_of_2026_10_01_is_the_cooldowns_end(self) -> None:
        row = self._record("claude_usage_limit_notice", hint=_WEEKLY_2026_10_01)
        self.assertEqual((row["until"], row["until_source"]), ("2026-10-02T06:00:00Z", "stated_reset"))
        self.assertEqual(row["reason"], "quota_unavailable")

    def test_a_dated_reset_is_read_in_its_own_year(self) -> None:
        row = self._record("claude_usage_limit_notice", hint=_WEEKLY_2026_08_22,
                           now=datetime(2026, 8, 22, 4, 0, tzinfo=timezone.utc))
        self.assertEqual(row["until"], "2026-08-23T10:00:00Z")

    def test_no_stated_reset_is_the_declared_default(self) -> None:
        row = self._record("claude_credit_error")
        self.assertEqual((row["until"], row["until_source"]), ("2026-10-01T23:43:23Z", "policy_default"))

    def test_a_reset_beyond_the_weekly_window_falls_back_to_the_default(self) -> None:
        row = self._record("claude_usage_limit_notice", hint="You've hit your weekly limit · resets Dec 1, 6am (UTC)")
        self.assertEqual(row["until_source"], "policy_default")

    def test_an_unknown_zone_falls_back_to_the_default(self) -> None:
        row = self._record("claude_usage_limit_notice", hint="You've hit your limit · resets 6am (Mars/Olympus)")
        self.assertEqual(row["until_source"], "policy_default")

    def test_auth_signatures_cool_as_auth(self) -> None:
        self.assertEqual(self._record("claude_auth_failure")["reason"], "auth_unavailable")
        self.assertEqual(self._record("zai_auth_refusal", provider="zai")["reason"], "auth_unavailable")

    def test_every_table_signature_cools_its_provider(self) -> None:
        for index, (signature, (provider, kind)) in enumerate(sorted(PROVIDER_EXHAUSTION_SIGNATURES.items())):
            with self.subTest(signature=signature):
                moment = self._NOW + timedelta(days=index)
                row = self._record(signature, provider=provider, now=moment, claim=f"CL-{index}")
                self.assertEqual(row["provider"], provider)
                self.assertEqual(row["reason"], {"quota": "quota_unavailable", "auth": "auth_unavailable",
                                                 "logged_out": "logged_out",  # ARIA-HIGH-366
                                                 "unreachable": "provider_unreachable"}[kind])
                self.assertIn(provider, active_provider_cooldowns(self.tools, now=moment + timedelta(seconds=1)))

    def test_an_unlisted_or_misattributed_signature_is_refused(self) -> None:
        for provider, detection in (("anthropic", {}), ("anthropic", {"signature": "claude_exit_1"}),
                                    ("zai", {"signature": "claude_usage_limit_notice"})):
            with self.subTest(provider=provider, detection=detection):
                with self.assertRaises(GovernanceError):
                    record_provider_cooldown(self.tools, provider=provider, model="m", cooldown_seconds=900,
                                             request_id="AIR-1", claim_id="CL-1", detection=detection, now=self._NOW)
        self.assertEqual(self._cooldown_rows(), [])


class TheCooldownIsWrittenOncePerTransition(_Tools):
    _NOW = datetime(2026, 10, 1, 23, 28, 23, tzinfo=timezone.utc)

    def _hit(self, claim: str, at: datetime) -> dict:
        return record_provider_cooldown(
            self.tools, provider="anthropic", model="opus", cooldown_seconds=900, request_id=f"AIR-{claim}",
            claim_id=claim, detection={"signature": "claude_usage_limit_notice", "reset_hint": _WEEKLY_2026_10_01},
            now=at,
        )

    def test_thirty_exhausted_requests_inside_one_window_write_one_row(self) -> None:
        first = self._hit("CL-0", self._NOW)
        for index in range(1, 30):
            standing = self._hit(f"CL-{index}", self._NOW + timedelta(minutes=index))
            self.assertEqual(standing["ledger_hash"], first["ledger_hash"], "the standing cooldown is returned")
        self.assertEqual(len(self._cooldown_rows()), 1)

    def test_a_new_exhaustion_after_the_window_is_a_new_transition(self) -> None:
        self._hit("CL-0", self._NOW)
        self._hit("CL-1", datetime(2026, 10, 2, 6, 0, 1, tzinfo=timezone.utc))
        self.assertEqual([row["claim_id"] for row in self._cooldown_rows()], ["CL-0", "CL-1"])


class AnExhaustionIsNeverARetryableFailure(unittest.TestCase):
    def _result(self, **kwargs) -> claude_runtime.ClaudeRunResult:
        base = dict(returncode=1, stdout="", stderr=_TRUST_NOTICE, final_message="", usage=None,
                    events=(_result_event(_WEEKLY_2026_10_01),))
        base.update(kwargs)
        events = base["events"]
        return claude_runtime.ClaudeRunResult(
            **base,
            credit_exhaustion=claude_runtime.extract_credit_exhaustion(
                returncode=base["returncode"], stderr=base["stderr"], events=events),
        )

    def test_the_2026_10_01_result_classifies_as_credit_exhausted_not_retryable(self) -> None:
        failure = classify_dispatch_failure(result=self._result(), phase="runtime")
        self.assertEqual((failure.failure_class, failure.retryable), ("credit_exhausted", False))

    def test_the_helper_raises_the_provider_exhaustion_instead_of_returning_exit_1(self) -> None:
        with self.assertRaises(claude_runtime.ClaudeCreditExhausted) as raised:
            claude_runtime.run_with_model_fallback(
                run=lambda model, effort: self._result(), model="opus", failover=None, effort="max",
                write_capable=False,
            )
        self.assertEqual(raised.exception.provider, "anthropic")
        self.assertEqual(raised.exception.detail["signature"], "claude_usage_limit_notice")


class TheRecordedTailEndsWithTheCause(unittest.TestCase):
    def test_the_trust_notice_no_longer_masks_the_weekly_limit(self) -> None:
        text = claude_runtime.failure_cause_text(stderr=_TRUST_NOTICE, events=(_result_event(_WEEKLY_2026_10_01),))
        self.assertTrue(text.rstrip().endswith(_WEEKLY_2026_10_01), text)
        self.assertIn("permissions.allow", text, "the notice is kept, ahead of the cause")
        # The executor keeps the LAST characters; the cause survives any length of notice.
        flooded = claude_runtime.failure_cause_text(
            stderr=_TRUST_NOTICE * 40, events=(_result_event(_WEEKLY_2026_10_01),),
        )
        self.assertIn(_WEEKLY_2026_10_01, flooded[-200:])

    def test_a_real_stderr_error_stays_after_the_notice(self) -> None:
        text = claude_runtime.failure_cause_text(
            stderr="API Error: 500 internal\n" + _TRUST_NOTICE, events=(),
        )
        self.assertTrue(text.rstrip().endswith("API Error: 500 internal"), text)


if __name__ == "__main__":
    unittest.main()
