"""ORPHAN-HIGH-787 — the auto-promote token is verified at consume time.

The consumer accepted any non-None token ("accepts on presence alone",
the mint side's own words). The token is now a self-describing
``v1:<base64url(payload)>:<hmac>`` envelope; `transition_tool` recomputes
the workspace-bound MAC and the tool binding before treating it as an
authority. A fabricated string, a cross-workspace replay and a cross-tool
replay must all read as "no token presented".
"""
from __future__ import annotations

import base64
import hmac
import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.adapter_calibration import (
    _derive_workspace_key,
    verify_auto_promote_token,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _envelope(payload: dict, key: bytes) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    mac = hmac.new(key, body, hashlib.sha256).hexdigest()
    body_b64 = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return f"v1:{body_b64}:{mac}"


def _payload(tool_id: str = "tool-a") -> dict:
    return {
        "tool_id": tool_id,
        "cycle_id": "cyc-1",
        "base_commit_sha": "a" * 40,
        "profile": "autonomous",
        "window_precision": [0.9],
        "window_recorded_at": ["2026-08-21T00:00:00+00:00"],
    }


class TokenVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-787-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.key = _derive_workspace_key(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_genuine_token_round_trips(self) -> None:
        token = _envelope(_payload(), self.key)
        verified = verify_auto_promote_token(token, tool_id="tool-a", base_dir=self.tools)
        self.assertIsNotNone(verified)
        self.assertEqual(verified["tool_id"], "tool-a")
        self.assertEqual(verified["cycle_id"], "cyc-1")

    def test_fabricated_string_is_no_token(self) -> None:
        # The exact pre-787 hole: any non-empty string satisfied the
        # predicate. Now it must read as absent.
        self.assertIsNone(verify_auto_promote_token("not-a-token", tool_id="tool-a", base_dir=self.tools))
        self.assertIsNone(verify_auto_promote_token("deadbeef", tool_id="tool-a", base_dir=self.tools))

    def test_wrong_workspace_key_does_not_verify(self) -> None:
        other_key = hashlib.sha256(b"another-workspace").digest()
        token = _envelope(_payload(), other_key)
        self.assertIsNone(verify_auto_promote_token(token, tool_id="tool-a", base_dir=self.tools))

    def test_tampered_payload_does_not_verify(self) -> None:
        token = _envelope(_payload(), self.key)
        body_b64, mac = token.split(":")[1], token.split(":")[2]
        decoded = base64.urlsafe_b64decode(body_b64 + "=" * (-len(body_b64) % 4))
        payload = json.loads(decoded)
        payload["window_precision"] = [1.0, 1.0, 1.0]  # better than earned
        tampered = _envelope(payload, self.key)
        # A re-signed tampered payload DOES verify as an envelope, but the
        # mint-side gates (precision history) produced the original window;
        # the envelope itself is unforgeable, so this arm only proves MAC
        # binding: the SAME payload re-signed with the right key is
        # indistinguishable from genuine — which is why the key is
        # workspace-bound and never leaves the kernel.
        verified = verify_auto_promote_token(tampered, tool_id="tool-a", base_dir=self.tools)
        self.assertIsNotNone(verified)  # right key, right tool: authentic envelope
        # A FLIPPED MAC byte, however, must fail.
        bad_mac = ("0" if mac[0] != "0" else "1") + mac[1:]
        self.assertIsNone(
            verify_auto_promote_token(f"v1:{body_b64}:{bad_mac}", tool_id="tool-a", base_dir=self.tools)
        )

    def test_cross_tool_replay_is_no_token(self) -> None:
        token = _envelope(_payload("tool-a"), self.key)
        self.assertIsNone(verify_auto_promote_token(token, tool_id="tool-b", base_dir=self.tools))

    def test_none_and_malformed_shapes_are_no_token(self) -> None:
        self.assertIsNone(verify_auto_promote_token(None, tool_id="tool-a", base_dir=self.tools))
        self.assertIsNone(verify_auto_promote_token("v1:!!!:abc", tool_id="tool-a", base_dir=self.tools))
        self.assertIsNone(verify_auto_promote_token("v2:xxx:yyy", tool_id="tool-a", base_dir=self.tools))
        self.assertIsNone(verify_auto_promote_token("v1:only-two", tool_id="tool-a", base_dir=self.tools))


class TransitionGateTests(unittest.TestCase):
    """The predicate reads verification, not presence — end to end."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-787-gate-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _shadow_tool(self) -> None:
        import base64 as _b64

        from aria_kernel import register_tool

        fake_runner = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"
        output = {"observations": [], "findings": [], "read_paths": ["src/app.ts"], "evidence_sources": ["src/app.ts"], "cost_units": 1}
        encoded = _b64.b64encode(json.dumps(output, separators=(",", ":")).encode("utf-8")).decode("ascii")
        register_tool(
            {
                "tool_id": "gate-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": ["src/**/*.ts"],
                "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
                "fixture_set": "fixtures/gate-adapter",
                "health_thresholds": {"max_cost_units": 10, "precision_min": 0.85},
                "allowed_read_globs": ["src/**/*.ts"],
                "forbidden_read_globs": [],
                "claim_types": ["drift"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess",
                    "argv": ["python3", fake_runner.as_posix(), "--output-b64", encoded],
                    "cwd": ".",
                    "timeout_ms": 5000,
                    "stdin_json": True,
                },
                "schema_version": 1,
            },
            base_dir=self.tools,
        )

    def test_fabricated_token_cannot_buy_the_gate(self) -> None:
        from aria_kernel import transition_tool

        self._shadow_tool()
        with self.assertRaises(GovernanceError) as ctx:
            transition_tool(
                "gate-adapter",
                "ACTIVE",
                reason="forged",
                precision=0.95,
                critical_false_positives=0,
                evidence_chains_valid=True,
                auto_promote_token="deadbeef-forged",
                base_dir=self.tools,
            )
        self.assertIn("operator_approval", str(ctx.exception))

    def test_genuine_token_passes_the_authority_clause(self) -> None:
        from aria_kernel import transition_tool
        from aria_kernel.adapter_calibration import _derive_workspace_key

        self._shadow_tool()
        token = _envelope(
            {
                "tool_id": "gate-adapter",
                "cycle_id": "cyc-1",
                "base_commit_sha": None,
                "profile": "autonomous",
                "window_precision": [0.95],
                "window_recorded_at": ["2026-08-21T00:00:00+00:00"],
            },
            _derive_workspace_key(self.tools),
        )
        result = transition_tool(
            "gate-adapter",
            "ACTIVE",
            reason="auto-promote, verified envelope",
            precision=0.95,
            critical_false_positives=0,
            evidence_chains_valid=True,
            auto_promote_token=token,
            base_dir=self.tools,
        )
        self.assertEqual(result["status"], "ACTIVE")


if __name__ == "__main__":
    unittest.main()
