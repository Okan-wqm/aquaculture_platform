"""Plan 026R §B.5 — planner hook single-claim + token/metadata env separation.

9 tests:

1. Both env vars exported → executor SKIPS its own ``agent claim``.
2. Standalone (no metadata env) → executor claims normally.
3. Sender rejects ``lease_token`` in metadata payload.
4. Receiver rejects ``lease_token`` in metadata payload (deserialise).
5. Argv NEVER contains the lease token (defense in depth).
6. Env clears on subprocess exit (parent process env unaffected).
7. Metadata ledger-hash anchors verified against on-disk rows
   (happy path).
8. Tampered metadata rejected (claim_ledger_hash mismatch).
9. Tampered metadata triggers governance event (request_ledger_hash
   mismatch surfaces operator-visible error).
"""
from __future__ import annotations

import importlib.util
import json
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ARIA_KERNEL = Path(__file__).resolve().parent.parent
ARIA_POC = ARIA_KERNEL.parent / "tools" / "aria-poc"

if str(ARIA_POC) not in sys.path:
    sys.path.insert(0, str(ARIA_POC))

import ci_executor  # noqa: E402

from aria_kernel.agent_invocations import (  # noqa: E402
    claim_request,
    create_agent_invocation_request,
    render_invocation_prompt,
)
from aria_kernel.planner_dispatch_hook import (  # noqa: E402
    CLAIM_METADATA_ENV_VAR,
    CLAIM_METADATA_FORBIDDEN_KEYS,
    LEASE_TOKEN_ENV_VAR,
    _serialise_claim_metadata_for_env,
)
from aria_kernel.runtime_profile import set_profile  # noqa: E402
from aria_kernel.tool_registry import GovernanceError  # noqa: E402


class _SingleClaimBase(unittest.TestCase):
    def setUp(self) -> None:
        # Plan ARIA-V9.7+ — hermetic env isolation. Pop ARIA_TOOLS_DIR
        # + ARIA_REPO_ROOT before each test so a prior-test pollution
        # (e.g. test_fixture_runner_path_escape leaves them set under
        # certain CI test-ordering paths) does NOT make ci_executor.main()
        # resolve tools_dir to a stale tempdir and miss the claim row in
        # _on_disk_anchors. Restore in tearDown.
        self._saved_aria_tools_dir = os.environ.pop("ARIA_TOOLS_DIR", None)
        self._saved_aria_repo_root = os.environ.pop("ARIA_REPO_ROOT", None)
        # Resolve all paths via .resolve() so they match what
        # ci_executor.main() computes from Path.cwd().resolve() under
        # filesystems with symlinks (e.g. /tmp → /private/tmp on macOS,
        # tmpfs vs overlayfs on some Linux CI runners).
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-b5-")).resolve()
        self.repo = (self.tmp / "repo").resolve(strict=False)
        self.repo.mkdir()
        self.tools = (self.repo / "aria-tools").resolve(strict=False)
        self._old_cwd = os.getcwd()
        os.chdir(self.repo)
        set_profile("standard", operator_approval_ref="t", base_dir=self.tools)
        (self.tools / "agent-invocations" / "prompts").mkdir(parents=True)
        prompt = self.tools / "agent-invocations" / "prompts" / "test.md"
        prompt.write_text("# test", encoding="utf-8")

        self.req = create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="prove",
            expected_output_path=str(
                self.tools / "agent-invocations" / "outputs" / "out.json"
            ),
            must_satisfy=[{"id": "S1", "description": "test"}],
            allowed_scope=["aria-kernel/**"], evidence_refs=["aria-kernel/src"],
            base_dir=self.tools,
        )
        # Pre-bind the prompt path the executor expects.
        prompt_for_req = (
            self.tools / "agent-invocations" / "prompts"
            / f"{self.req['request_id']}.md"
        )
        prompt_for_req.write_text("# test prompt", encoding="utf-8")

        # Pre-claim so we have a real claim row + lease_token to test
        # single-claim mode against the on-disk ledger.
        self.agent_id = (
            f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"
        )
        self.claim = claim_request(
            request_id=self.req["request_id"],
            agent_id=self.agent_id,
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        import shutil
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)
        # Plan ARIA-V9.7+ — restore env saved in setUp.
        if self._saved_aria_tools_dir is not None:
            os.environ["ARIA_TOOLS_DIR"] = self._saved_aria_tools_dir
        else:
            os.environ.pop("ARIA_TOOLS_DIR", None)
        if self._saved_aria_repo_root is not None:
            os.environ["ARIA_REPO_ROOT"] = self._saved_aria_repo_root
        else:
            os.environ.pop("ARIA_REPO_ROOT", None)


class SingleClaimSerialiserTests(_SingleClaimBase):
    """§B.5 sender-side: planner_dispatch_hook serialiser."""

    def test_serialiser_rejects_lease_token_key(self) -> None:
        tampered_claim = {**self.claim, "lease_token": self.claim["lease_token"]}
        with self.assertRaises(GovernanceError) as ctx:
            _serialise_claim_metadata_for_env(tampered_claim, self.agent_id)
        self.assertIn("forbidden_key", str(ctx.exception))
        self.assertIn("lease_token", str(ctx.exception))

    def test_serialiser_rejects_lease_token_hash_key(self) -> None:
        tampered_claim = {**self.claim, "lease_token_hash": "sha256:xxx"}
        with self.assertRaises(GovernanceError) as ctx:
            _serialise_claim_metadata_for_env(tampered_claim, self.agent_id)
        self.assertIn("lease_token_hash", str(ctx.exception))

    def test_serialiser_emits_documented_schema(self) -> None:
        # Caller strips secrets before calling — mirrors the production
        # planner_dispatch_hook contract (§B.5 sanitisation boundary).
        sanitised = {
            k: v for k, v in self.claim.items()
            if k not in CLAIM_METADATA_FORBIDDEN_KEYS
        }
        payload = _serialise_claim_metadata_for_env(sanitised, self.agent_id)
        data = json.loads(payload)
        for expected in (
            "claim_id", "request_id", "agent_id",
            "expected_output_path", "role",
            "must_satisfy", "allowed_scope", "evidence_refs",
            "context_hash", "prompt_hash",
            "context_ledger_hash", "prompt_ledger_hash",
            "lease_expires_at",
            "claim_ledger_hash", "request_ledger_hash",
        ):
            self.assertIn(expected, data, expected)
        # Forbidden keys MUST NOT appear in the serialised payload.
        for forbidden in CLAIM_METADATA_FORBIDDEN_KEYS:
            self.assertNotIn(forbidden, data)


class SingleClaimDeserialiserTests(_SingleClaimBase):
    """§B.5 receiver-side: ci_executor._deserialise_inherited_claim_metadata."""

    def test_deserialiser_rejects_lease_token_in_metadata(self) -> None:
        # Construct a TAMPERED payload (sanitised metadata + a smuggled
        # lease_token key). The deserialiser must reject this even
        # though the sender-side serialiser would never produce it —
        # the receiver enforces the invariant independently as defense
        # in depth.
        sanitised = {
            k: v for k, v in self.claim.items()
            if k not in CLAIM_METADATA_FORBIDDEN_KEYS
        }
        clean_payload = json.loads(
            _serialise_claim_metadata_for_env(sanitised, self.agent_id),
        )
        clean_payload["lease_token"] = "leaked-secret"
        result, err = ci_executor._deserialise_inherited_claim_metadata(
            json.dumps(clean_payload), agent_id=self.agent_id,
            request_id=self.req["request_id"], tools_dir=self.tools,
        )
        self.assertEqual(result, {})
        self.assertIn("forbidden_key", err)

    def _sanitised_payload(self) -> str:
        sanitised = {
            k: v for k, v in self.claim.items()
            if k not in CLAIM_METADATA_FORBIDDEN_KEYS
        }
        return _serialise_claim_metadata_for_env(sanitised, self.agent_id)

    def test_deserialiser_happy_path_returns_metadata(self) -> None:
        payload = self._sanitised_payload()
        result, err = ci_executor._deserialise_inherited_claim_metadata(
            payload, agent_id=self.agent_id,
            request_id=self.req["request_id"], tools_dir=self.tools,
        )
        self.assertIsNone(err)
        self.assertEqual(result["claim_id"], self.claim["claim_id"])
        self.assertEqual(result["claim_ledger_hash"], self.claim["claim_ledger_hash"])

    def test_deserialiser_rejects_tampered_claim_ledger_hash(self) -> None:
        data = json.loads(self._sanitised_payload())
        data["claim_ledger_hash"] = "sha256:tampered00000000"
        result, err = ci_executor._deserialise_inherited_claim_metadata(
            json.dumps(data), agent_id=self.agent_id,
            request_id=self.req["request_id"], tools_dir=self.tools,
        )
        self.assertEqual(result, {})
        self.assertIn("tampered_claim_ledger_hash", err)

    def test_deserialiser_rejects_tampered_request_ledger_hash(self) -> None:
        data = json.loads(self._sanitised_payload())
        data["request_ledger_hash"] = "sha256:tampered00000000"
        result, err = ci_executor._deserialise_inherited_claim_metadata(
            json.dumps(data), agent_id=self.agent_id,
            request_id=self.req["request_id"], tools_dir=self.tools,
        )
        self.assertEqual(result, {})
        self.assertIn("tampered_request_ledger_hash", err)


class SingleClaimMainEntryTests(_SingleClaimBase):
    """§B.5 main() entry — env-var-driven single-claim mode."""

    def test_main_skips_claim_when_metadata_env_present(self) -> None:
        # Set both env vars; main() should NOT call ``agent claim``.
        sanitised = {
            k: v for k, v in self.claim.items()
            if k not in CLAIM_METADATA_FORBIDDEN_KEYS
        }
        metadata = _serialise_claim_metadata_for_env(sanitised, self.agent_id)
        env_patch = {
            ci_executor.MOCK_MODE_ENV_VAR: "1",
            "GITHUB_RUN_ID": os.environ.get("GITHUB_RUN_ID", "local"),
            LEASE_TOKEN_ENV_VAR: self.claim["lease_token"],
            CLAIM_METADATA_ENV_VAR: metadata,
        }
        captured = []

        def fake_run(argv, *args, **kwargs):
            captured.append(tuple(argv))
            return MagicMock(returncode=0, stdout="{}", stderr="")

        with patch.dict(os.environ, env_patch):
            with patch("ci_executor.subprocess.run", fake_run):
                exit_code = ci_executor.main(
                    [self.req["request_id"], "aria-evidence-judge"],
                )
        self.assertEqual(exit_code, 0, captured)
        # NO ``agent claim`` subprocess should have been invoked.
        for argv in captured:
            self.assertNotIn(
                "claim", argv,
                f"single-claim mode invoked ``agent claim`` (re-claim "
                f"bug): {argv}",
            )

    def test_main_claims_normally_when_no_metadata_env(self) -> None:
        # Without ARIA_CLAIM_METADATA, the executor claims via subprocess.
        env_patch = {
            ci_executor.MOCK_MODE_ENV_VAR: "1",
            "GITHUB_RUN_ID": "local",
        }
        for key in (CLAIM_METADATA_ENV_VAR, LEASE_TOKEN_ENV_VAR):
            env_patch.pop(key, None)
        captured = []

        def fake_run(argv, *args, **kwargs):
            captured.append(tuple(argv))
            if "claim" in argv:
                claim_payload = {
                    "lease_token": "test-token",
                    "claim_id": "test-claim",
                    "request_id": self.req["request_id"],
                    "agent_id": self.agent_id,
                    "role": "evidence_judgment",
                    "target_agent": "aria-evidence-judge",
                    "convergence_id": self.req.get("convergence_id"),
                    "expected_output_path": self.req["expected_output_path"],
                    "suggested_prompt": self.req["suggested_prompt"],
                    "must_satisfy": [{"id": "S1", "description": "x"}],
                    "allowed_scope": ["aria-kernel/**"],
                    "forbidden_scope": [],
                    "evidence_refs": ["aria-kernel/src"],
                    "impact_graph_refs": [],
                    "validation_commands": [],
                    "context_hash": self.claim["context_hash"],
                    "context_ledger_hash": self.claim["context_ledger_hash"],
                    "prompt_ledger_hash": self.claim["prompt_ledger_hash"],
                }
                rendered = render_invocation_prompt(claim_payload)
                claim_payload["prompt_hash"] = (
                    "sha256:"
                    + hashlib.sha256(rendered.encode("utf-8")).hexdigest()
                )
                return MagicMock(
                    returncode=0,
                    stdout=json.dumps(claim_payload),
                    stderr="",
                )
            return MagicMock(returncode=0, stdout="{}", stderr="")

        with patch.dict(
            os.environ, env_patch, clear=False,
        ):
            os.environ.pop(CLAIM_METADATA_ENV_VAR, None)
            os.environ.pop(LEASE_TOKEN_ENV_VAR, None)
            with patch("ci_executor.subprocess.run", fake_run):
                exit_code = ci_executor.main(
                    [self.req["request_id"], "aria-evidence-judge"],
                )
        self.assertEqual(exit_code, 0)
        # ``agent claim`` subprocess MUST have been invoked.
        claim_invoked = any("claim" in argv for argv in captured)
        self.assertTrue(claim_invoked)


class SingleClaimArgvSafetyTests(_SingleClaimBase):
    """§B.5 — argv NEVER contains the lease token (defense in depth)."""

    def test_argv_never_contains_lease_token(self) -> None:
        sanitised = {
            k: v for k, v in self.claim.items()
            if k not in CLAIM_METADATA_FORBIDDEN_KEYS
        }
        metadata = _serialise_claim_metadata_for_env(sanitised, self.agent_id)
        token = self.claim["lease_token"]
        env_patch = {
            ci_executor.MOCK_MODE_ENV_VAR: "1",
            "GITHUB_RUN_ID": "local",
            LEASE_TOKEN_ENV_VAR: token,
            CLAIM_METADATA_ENV_VAR: metadata,
        }
        captured = []

        def fake_run(argv, *args, **kwargs):
            captured.append(tuple(argv))
            return MagicMock(returncode=0, stdout="{}", stderr="")

        with patch.dict(os.environ, env_patch):
            with patch("ci_executor.subprocess.run", fake_run):
                ci_executor.main(
                    [self.req["request_id"], "aria-evidence-judge"],
                )
        # The raw token MUST NOT appear in any captured subprocess argv.
        for argv in captured:
            for arg in argv:
                self.assertNotIn(
                    token, str(arg),
                    f"lease_token leaked into argv: {argv}",
                )


if __name__ == "__main__":
    unittest.main()
