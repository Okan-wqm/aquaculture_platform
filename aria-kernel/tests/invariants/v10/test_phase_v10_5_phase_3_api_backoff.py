"""Plan ARIA-V10.5 Phase 3 — F-023 API backoff invariants.

Closes F-023 (Anthropic API 529 transient retry policy).
Reference: ADR-0001 (EXTERNAL_OUTAGE lifecycle state).

11 invariants validate the V10.5 Phase 3 architectural contract:
- Backoff disabled by default (V10.4 behavior preserved byte-identical)
- 529 detection (stderr + envelope text, both anchored)
- Retry-after header parsing (Anthropic SDK best practice)
- HUMAN_REQUIRED stickiness preservation (EXTERNAL_OUTAGE ordering)
- External outage reaper (30 min requeue + 4-requeue escalation)
- SIGTERM-aware sleep (threading.Event NOT time.sleep)
- Env scrub (CLAUDE_*/CLAUDECODE strip per retry attempt)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

# Tools path injection for api_backoff import
_TOOLS_DIR = Path(__file__).resolve().parents[4] / "tools" / "aria-poc"
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from api_backoff import (  # noqa: E402
    APIOutageDetected,
    CycleOutageBudgetExceeded,
    RetryPolicy,
    _detect_529,
    _parse_retry_after,
    _scrub_env,
    with_api_backoff,
)

from aria_kernel import agent_invocations  # noqa: E402
from aria_kernel import external_outage_reaper  # noqa: E402
from aria_kernel.ledger import LedgerIntegrityError, append_declared_jsonl  # noqa: E402
from aria_kernel.tool_registry import ensure_tools_binding  # noqa: E402


_REPO_ROOT = Path(__file__).resolve().parents[4]


def _seed_claims_ledger(tmpdir: str, rows: list[dict]) -> Path:
    tools = Path(tmpdir) / "aria-tools"
    ensure_tools_binding(tools, workspace_root=_REPO_ROOT)
    claims_path = tools / "agent-invocations" / "claims.jsonl"
    for row in rows:
        append_declared_jsonl(
            claims_path,
            row,
            expected_surface=external_outage_reaper.CLAIMS_SURFACE,
        )
    return claims_path


def _make_completed(returncode: int, stdout: bytes = b"", stderr: bytes = b""):
    """Helper: construct a CompletedProcess for mocking."""
    proc = subprocess.CompletedProcess(args=["mock"], returncode=returncode)
    proc.stdout = stdout
    proc.stderr = stderr
    return proc


class APIBackoff529DetectionInvariants(unittest.TestCase):
    """Invariants 1-2: 529 detection via stderr + envelope text."""

    def test_i_v10_5_phase3_01_stderr_529_detected(self):
        """529 in stderr triggers detection."""
        self.assertTrue(_detect_529(
            stdout=b"",
            stderr=b"HTTP/1.1 529 Overloaded\nServer rejected request",
        ))
        self.assertTrue(_detect_529(
            stdout=b"",
            stderr=b"anthropic.APIError: 529 server overloaded\n",
        ))

    def test_i_v10_5_phase3_02_envelope_529_detected(self):
        """529 in stdout envelope text triggers detection (anchored)."""
        self.assertTrue(_detect_529(
            stdout=b'{"response": "API Error: 529 Overloaded"}',
            stderr=b"",
        ))


class APIBackoffFalsePositiveInvariants(unittest.TestCase):
    """Invariant 3: non-529 errors pass through unchanged."""

    def test_i_v10_5_phase3_03_non_529_pass_through(self):
        """Random text mentioning '529' tokens NOT in anchored pattern."""
        # "529 tokens" is a substring but not the anchored 529 status code form
        self.assertFalse(_detect_529(
            stdout=b'{"info": "processed 529 records"}',
            stderr=b"INFO: completed 529 events",
        ))

    def test_i_v10_5_phase3_03b_non_529_stderr(self):
        """500 / 503 / timeout stderr does NOT trigger backoff."""
        self.assertFalse(_detect_529(
            stdout=b"",
            stderr=b"HTTP/1.1 500 Internal Server Error",
        ))
        self.assertFalse(_detect_529(
            stdout=b"",
            stderr=b"HTTP/1.1 503 Service Unavailable",
        ))


class APIBackoffRetryAfterInvariants(unittest.TestCase):
    """Invariant 6: retry-after header parsing (SDK best practice)."""

    def test_i_v10_5_phase3_06_retry_after_parsed(self):
        """retry-after: 10 in stderr → 10s parsed."""
        self.assertEqual(_parse_retry_after(b"retry-after: 10\n"), 10)
        self.assertEqual(_parse_retry_after(b"Retry-After: 30"), 30)

    def test_i_v10_5_phase3_06b_retry_after_absent(self):
        """No retry-after → None returned (use fallback)."""
        self.assertIsNone(_parse_retry_after(b""))
        self.assertIsNone(_parse_retry_after(b"random stderr line"))


class APIBackoffEnvScrubInvariants(unittest.TestCase):
    """Invariant 11: env scrub (V10.4 F-016 layer 2)."""

    def test_i_v10_5_phase3_11_env_scrub_strips_claude_prefixes(self):
        """_scrub_env removes CLAUDE_*/CLAUDECODE inherited vars."""
        env = {
            "PATH": "/usr/bin",
            "HOME": "/root",
            "CLAUDE_CODE_OAUTH_TOKEN": "secret",
            "CLAUDE_CODE_SESSION_ID": "xyz",
            "CLAUDECODE": "1",
            "ARIA_API_BACKOFF": "1",
        }
        scrubbed = _scrub_env(env)
        self.assertIn("PATH", scrubbed)
        self.assertIn("HOME", scrubbed)
        self.assertIn("ARIA_API_BACKOFF", scrubbed)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", scrubbed)
        self.assertNotIn("CLAUDE_CODE_SESSION_ID", scrubbed)
        self.assertNotIn("CLAUDECODE", scrubbed)


class APIBackoffDisabledByDefaultInvariants(unittest.TestCase):
    """Invariant 5: backoff dormant by default (V10.4 behavior preserved)."""

    def test_i_v10_5_phase3_05_disabled_by_default_single_call(self):
        """RetryPolicy.enabled=False → exactly 1 subprocess.run call."""
        call_count = [0]
        def fake_call():
            call_count[0] += 1
            return _make_completed(returncode=1, stderr=b"HTTP/1.1 529 Overloaded")

        with tempfile.TemporaryDirectory() as tmpdir:
            # Ensure env var is unset.
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("ARIA_API_BACKOFF", None)
                result = with_api_backoff(
                    fake_call,
                    request_id="AIR-test-disabled",
                    role="cross_review",
                    tools_dir=Path(tmpdir),
                    retry_policy=RetryPolicy(),  # default enabled=False
                )
        self.assertEqual(call_count[0], 1)
        self.assertEqual(result.returncode, 1)


class APIBackoffExhaustionInvariants(unittest.TestCase):
    """Invariant 4: 4 attempts → APIOutageDetected raised."""

    def test_i_v10_5_phase3_04_exhaustion_raises(self):
        """All retry attempts hit 529 → APIOutageDetected raised."""
        def fake_call():
            return _make_completed(returncode=1, stderr=b"HTTP/1.1 529 Overloaded")

        # Mock _cancellable_sleep to instantly return True (skip real sleeps)
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("api_backoff._cancellable_sleep", return_value=True):
                policy = RetryPolicy(enabled=True, attempts=2)
                with self.assertRaises(APIOutageDetected):
                    with_api_backoff(
                        fake_call,
                        request_id="AIR-test-exhausted",
                        role="cross_review",
                        tools_dir=Path(tmpdir),
                        retry_policy=policy,
                    )


class APIBackoffPartialOutageInvariants(unittest.TestCase):
    """Invariant 7: 200→529→200 partial outage → 1 retry, success."""

    def test_i_v10_5_phase3_07_partial_outage_recovers(self):
        """Mid-retry transient: success after 1 retry, no exception."""
        responses = iter([
            _make_completed(returncode=1, stderr=b"HTTP/1.1 529 Overloaded"),
            _make_completed(returncode=0, stdout=b'{"ok": true}'),
        ])
        def fake_call():
            return next(responses)

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("api_backoff._cancellable_sleep", return_value=True):
                policy = RetryPolicy(enabled=True, attempts=2)
                result = with_api_backoff(
                    fake_call,
                    request_id="AIR-test-partial",
                    role="primary_plan",
                    tools_dir=Path(tmpdir),
                    retry_policy=policy,
                )
        self.assertEqual(result.returncode, 0)


class APIBackoffSIGTERMInvariants(unittest.TestCase):
    """Invariant 9: SIGTERM during sleep exits within 2s."""

    def test_i_v10_5_phase3_09_sigterm_during_sleep_exits(self):
        """interrupt_event.set() during backoff sleep raises APIOutageDetected."""
        def fake_call():
            return _make_completed(returncode=1, stderr=b"HTTP/1.1 529 Overloaded")

        interrupt = threading.Event()
        # Trigger interrupt 100ms into the test
        timer = threading.Timer(0.1, interrupt.set)
        timer.start()

        with tempfile.TemporaryDirectory() as tmpdir:
            policy = RetryPolicy(
                enabled=True,
                attempts=2,
                base_backoffs=(2, 2, 2),  # short for test
                respect_retry_after=False,
            )
            start = time.monotonic()
            with self.assertRaises(APIOutageDetected):
                with_api_backoff(
                    fake_call,
                    request_id="AIR-test-sigterm",
                    role="cross_review",
                    tools_dir=Path(tmpdir),
                    retry_policy=policy,
                    interrupt_event=interrupt,
                )
            elapsed = time.monotonic() - start
        timer.cancel()
        # Should exit within ~2s (interrupt fired at 100ms; first sleep 2s
        # max + cancellation grace ≤2s)
        self.assertLess(elapsed, 3.0,
            f"SIGTERM-during-sleep should exit promptly; got {elapsed:.2f}s")


class APIBackoffStateOrderingInvariants(unittest.TestCase):
    """Invariant 8: HUMAN_REQUIRED stickiness preserved post-EXTERNAL_OUTAGE."""

    def test_i_v10_5_phase3_08_human_required_sticky_source_check(self):
        """Source-level invariant: HUMAN_REQUIRED check appears BEFORE
        EXTERNAL_OUTAGE check in derive_request_state.

        Per ADR-0001: HUMAN_REQUIRED stickiness must be preserved.
        A transient API outage must NOT cancel operator review intent.
        """
        import inspect
        src = inspect.getsource(agent_invocations.derive_request_state)
        # Find positions of the two checks in source order.
        human_idx = src.find('"HUMAN_REQUIRED"')
        outage_idx = src.find('"EXTERNAL_OUTAGE"')
        self.assertGreater(
            human_idx, 0,
            "derive_request_state must check HUMAN_REQUIRED (sticky)"
        )
        self.assertGreater(
            outage_idx, 0,
            "derive_request_state must check EXTERNAL_OUTAGE (V10.5 Phase 3)"
        )
        self.assertLess(
            human_idx, outage_idx,
            "I-V10.5-PHASE3-08: HUMAN_REQUIRED check MUST appear BEFORE "
            "EXTERNAL_OUTAGE check in derive_request_state source. "
            "Reordering would let a transient API outage escape "
            "operator review (SEC-HIGH-005 audit finding). Per ADR-0001."
        )


class ExternalOutageReaperInvariants(unittest.TestCase):
    """Invariant 10: reaper requeues after 30 min + escalates after 4 requeues."""

    def test_i_v10_5_phase3_10_reaper_requeues_after_window(self):
        """Reaper appends 'requeued' event when window elapsed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            past = datetime.now(timezone.utc) - timedelta(seconds=2000)
            rows = [
                {"request_id": "AIR-test-reap-1", "event": "claimed",
                 "occurred_at": "2026-05-20T09:00:00Z"},
                {"request_id": "AIR-test-reap-1", "event": "api_backoff_exhausted",
                 "occurred_at": past.isoformat()},
            ]
            claims_path = _seed_claims_ledger(tmpdir, rows)
            summary = external_outage_reaper.reap_external_outage_requests(
                claims_path=claims_path,
            )
            self.assertEqual(summary["requeued_count"], 1)
            self.assertIn("AIR-test-reap-1", summary["request_ids_requeued"])

    def test_i_v10_5_phase3_10b_reaper_escalates_after_4_requeues(self):
        """Reaper escalates to human_required after MAX_EXTERNAL_OUTAGE_REQUEUES."""
        with tempfile.TemporaryDirectory() as tmpdir:
            past = datetime.now(timezone.utc) - timedelta(seconds=2000)
            rows = [{"request_id": "AIR-test-escalate", "event": "claimed",
                     "occurred_at": "2026-05-20T08:00:00Z"}]
            # 4 prior requeues (matches MAX_EXTERNAL_OUTAGE_REQUEUES)
            for i in range(4):
                rows.append({
                    "request_id": "AIR-test-escalate",
                    "event": "requeued",
                    "reason": "external_outage_requeue",
                    "occurred_at": f"2026-05-20T0{8+i}:30:00Z",
                })
            # Final api_backoff_exhausted in the past
            rows.append({
                "request_id": "AIR-test-escalate",
                "event": "api_backoff_exhausted",
                "occurred_at": past.isoformat(),
            })
            claims_path = _seed_claims_ledger(tmpdir, rows)
            summary = external_outage_reaper.reap_external_outage_requests(
                claims_path=claims_path,
            )
            self.assertEqual(summary["escalated_count"], 1)
            self.assertIn("AIR-test-escalate", summary["request_ids_escalated"])

    def test_i_v10_5_phase3_10c_reaper_rejects_raw_claims_path(self):
        """Reaper must use the declared agent-invocation claims surface."""
        with tempfile.TemporaryDirectory() as tmpdir:
            claims_path = Path(tmpdir) / "claims.jsonl"
            claims_path.write_text(
                json.dumps({
                    "request_id": "AIR-test-raw",
                    "event": "api_backoff_exhausted",
                    "occurred_at": (
                        datetime.now(timezone.utc) - timedelta(seconds=2000)
                    ).isoformat(),
                }) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                LedgerIntegrityError,
                "declared_surface_unresolved",
            ):
                external_outage_reaper.reap_external_outage_requests(
                    claims_path=claims_path,
                )


class DerivedStatesEnumInvariants(unittest.TestCase):
    """Invariant 12: EXTERNAL_OUTAGE is in DERIVED_STATES tuple."""

    def test_i_v10_5_phase3_12_external_outage_in_enum(self):
        """EXTERNAL_OUTAGE registered in DERIVED_STATES."""
        self.assertIn("EXTERNAL_OUTAGE", agent_invocations.DERIVED_STATES)


if __name__ == "__main__":
    unittest.main()
