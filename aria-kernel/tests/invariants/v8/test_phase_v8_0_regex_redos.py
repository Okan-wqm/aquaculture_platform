"""Plan ORPHAN-HIGH-081 — _AGENT_REF_RE ReDoS regression invariants.

Closes ORPHAN-HIGH-081. 4 invariants pin the regex's deterministic shape +
linear-time behavior so a future "simplification" cannot accidentally
re-introduce the catastrophic-backtracking pattern that hung
submit_claim_result for ~120s per envelope on 2026-05-18.

Pre-fix shape (caused exponential backtracking):
    ^(?P<path>[^\\s:][^\\s:]*(?:[^\\s:][^\\s:]*)*?)(?::(?P<line>\\d+))?$
The path group contains `X+(X+)*?` over the same character class — every
rejected input forced the engine to try 2^N partitions of the path.

Post-fix shape (linear time, same language):
    ^(?P<path>[^\\s:]+)(?::(?P<line>\\d+))?$

Invariants:

- I-V8.0-REDOS-01 — semantic equivalence: valid inputs still match with
  identical groups.
- I-V8.0-REDOS-02 — rejected pathological inputs (path with two colons
  and a content tail) complete in <100ms (was unbounded; ~120s on
  real production envelopes).
- I-V8.0-REDOS-03 — no nested-quantifier pattern in the regex source.
  Source-substring check that rejects any `[^\\s:]*(?:[^\\s:]` shape
  (the dangerous overlap) and confirms the safe `[^\\s:]+` shape.
- I-V8.0-REDOS-04 — boundary inputs (empty, whitespace, colon-only)
  return None deterministically (semantic preservation).
"""
from __future__ import annotations

import inspect
import signal
import time
import unittest

from . import _helpers  # noqa: F401

from aria_kernel import evidence_validator
from aria_kernel.evidence_validator import _AGENT_REF_RE, _parse_agent_ref


class _AlarmTimeout(Exception):
    pass


def _alarm(_sig, _frame):
    raise _AlarmTimeout()


class TestRegexNoCatastrophicBacktracking(unittest.TestCase):

    def test_i_v8_0_redos_01_semantic_equivalence_on_valid_inputs(self):
        """Valid path[:line] inputs MUST still match with the expected
        path and line groups."""
        cases = [
            ("foo.py", ("foo.py", None)),
            ("apps/svc/main.ts:42", ("apps/svc/main.ts", 42)),
            ("aria-kernel/aria_kernel/cli.py:3452", ("aria-kernel/aria_kernel/cli.py", 3452)),
            ("a", ("a", None)),
            ("a:1", ("a", 1)),
        ]
        for inp, expected in cases:
            with self.subTest(inp=inp):
                result = _parse_agent_ref(inp)
                self.assertEqual(result, expected)

    def test_i_v8_0_redos_02_pathological_input_completes_under_100ms(self):
        """The pre-fix regex burned ~120s of CPU on plan_synthesizer's
        `path:line:content` format. Post-V8.3 fix MUST complete in
        <100ms on the same input; post-V8.6 fix also ACCEPTS the
        triplet form as a valid evidence_ref (path + line) and
        ignores the trailing :content excerpt. Either outcome
        (matched OR rejected) MUST be linear time."""
        triplet_inputs = [
            "x" * 30 + ":1:content here",
            "x" * 50 + ":42:content here that goes on",
            "aria-kernel/aria_kernel/autonomy_orchestrator.py:3:Operator vision center-piece text",
            "aria-kernel/tests/invariants/v8/test_phase_v8_0_plumbing.py:3:Closes ORPHAN-HIGH-082",
        ]
        # `a*80::garbage` still has NO digit after the first colon
        # (the second colon directly follows it), so the line-number
        # group MUST fail and the whole match MUST reject. The regex
        # is still bounded.
        rejected_inputs = [
            "a" * 80 + "::garbage",
        ]
        for inp in triplet_inputs:
            with self.subTest(inp_len=len(inp), kind="triplet_accepted"):
                signal.signal(signal.SIGALRM, _alarm)
                signal.setitimer(signal.ITIMER_REAL, 0.5)
                try:
                    t = time.monotonic()
                    result = _AGENT_REF_RE.match(inp)
                    elapsed = time.monotonic() - t
                    # V8.6 — path:line:content MUST be accepted; the
                    # path + line groups carry the canonical pair,
                    # the trailing :content excerpt is captured and
                    # discarded by `(?::.*)?`.
                    self.assertIsNotNone(
                        result,
                        f"path:line:content MUST match after V8.6 regex extension: {inp!r}",
                    )
                    self.assertLess(
                        elapsed, 0.1,
                        f"regex took {elapsed*1000:.1f}ms on len={len(inp)} input — "
                        "catastrophic backtracking regression",
                    )
                except _AlarmTimeout:
                    self.fail(
                        f"regex did not complete within 500ms on len={len(inp)} "
                        "input — catastrophic backtracking regression "
                        "(ORPHAN-HIGH-081 reverted)"
                    )
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
        for inp in rejected_inputs:
            with self.subTest(inp_len=len(inp), kind="malformed_rejected"):
                signal.signal(signal.SIGALRM, _alarm)
                signal.setitimer(signal.ITIMER_REAL, 0.5)
                try:
                    t = time.monotonic()
                    result = _AGENT_REF_RE.match(inp)
                    elapsed = time.monotonic() - t
                    self.assertIsNone(result)
                    self.assertLess(elapsed, 0.1)
                except _AlarmTimeout:
                    self.fail(f"regex hang on rejected input {inp!r}")
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)

    def test_i_v8_0_redos_03_no_nested_overlapping_quantifier(self):
        """Source-substring check on the regex ASSIGNMENT line ONLY
        (not comments). The compiled regex pattern MUST NOT contain
        the catastrophic `[^\\s:]*(?:[^\\s:]` overlap AND MUST contain
        the safe `[^\\s:]+` form. Lint-style guard against the
        original accidental complication returning under refactor."""
        src = inspect.getsource(evidence_validator)
        # Find the actual assignment line (skip comments)
        assign_lines = [
            line for line in src.splitlines()
            if line.lstrip().startswith("_AGENT_REF_RE")
            and "re.compile" in line
        ]
        self.assertEqual(
            len(assign_lines), 1,
            f"expected exactly 1 _AGENT_REF_RE compile line, found {len(assign_lines)}",
        )
        assign = assign_lines[0]
        # Negative: the dangerous overlap must NOT reappear on the compile line
        self.assertNotIn(
            r"[^\s:]*(?:[^\s:]", assign,
            "ReDoS regression: dangerous nested-quantifier overlap "
            f"[^\\s:]*(?:[^\\s:] is back in: {assign.strip()}",
        )
        # Positive: the safe replacement MUST be present on the compile line
        self.assertIn(
            r"[^\s:]+", assign,
            f"compile line MUST use simple [^\\s:]+ form: {assign.strip()}",
        )

    def test_i_v8_0_redos_04_boundary_inputs_return_none_deterministically(self):
        """Empty, whitespace-only, and colon-only inputs MUST return
        None (no spurious matches, no hangs)."""
        boundaries = ["", " ", ":", "::", " : ", ":1", ":1:"]
        for inp in boundaries:
            with self.subTest(inp=repr(inp)):
                signal.signal(signal.SIGALRM, _alarm)
                signal.setitimer(signal.ITIMER_REAL, 0.1)
                try:
                    result = _parse_agent_ref(inp)
                    self.assertIsNone(
                        result,
                        f"boundary input {inp!r} should return None, got {result!r}",
                    )
                except _AlarmTimeout:
                    self.fail(f"regex hang on boundary input {inp!r}")
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == "__main__":
    unittest.main()
