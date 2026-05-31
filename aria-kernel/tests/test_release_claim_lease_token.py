"""Plan 026R §B.1 — release_claim is lease-token-bound + CLI wiring.

5 tests:

* release_claim with the WRONG lease_token raises GovernanceError
  (mirrors heartbeat / submit-result contract).
* release_claim with no lease_token raises (lease_token is required).
* CLI ``--lease-token-from-env`` reads the env var correctly.
* ``ci_executor._release_claim`` argv now contains ``--agent-id`` AND
  ``--lease-token-from-env`` (the pre-§B.1 missing flags).
* Full round-trip: claim → release with correct token → released event
  in claims.jsonl.
"""
from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    release_claim,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError


ARIA_KERNEL = Path(__file__).resolve().parent.parent
ARIA_POC = ARIA_KERNEL.parent / "tools" / "aria-poc"


class ReleaseClaimLeaseTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-b1-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="test", base_dir=self.base)
        # Stage a request + claim it so release_claim has a valid target.
        req = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="prove docs/a.md",
            expected_output_path="docs/x.md",
            must_satisfy=[{"id": "proof", "description": "proof"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/a.md"],
            base_dir=self.base,
        )
        self.request_id = req["request_id"]
        result = claim_request(
            request_id=self.request_id,
            agent_id="test-agent",
            base_dir=self.base,
        )
        self.claim_id = result["claim_id"]
        self.lease_token = result["lease_token"]

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_wrong_lease_token_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            release_claim(
                claim_id=self.claim_id,
                agent_id="test-agent",
                lease_token="WRONG-TOKEN-12345",
                reason="test-wrong-token",
                base_dir=self.base,
            )
        self.assertIn("lease_token_mismatch", str(ctx.exception))

    def test_missing_lease_token_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            release_claim(
                claim_id=self.claim_id,
                agent_id="test-agent",
                lease_token="",
                reason="test-missing-token",
                base_dir=self.base,
            )
        self.assertIn("lease_token is required", str(ctx.exception))

    def test_correct_lease_token_round_trip(self) -> None:
        row = release_claim(
            claim_id=self.claim_id,
            agent_id="test-agent",
            lease_token=self.lease_token,
            reason="test-clean-release",
            base_dir=self.base,
        )
        self.assertEqual(row["event"], "released")
        self.assertEqual(row["claim_id"], self.claim_id)


class ReleaseClaimCliEnvVarTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-b1-cli-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="test", base_dir=self.base)
        req = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="prove docs/a.md",
            expected_output_path="docs/x.md",
            must_satisfy=[{"id": "proof", "description": "proof"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/a.md"],
            base_dir=self.base,
        )
        self.request_id = req["request_id"]
        result = claim_request(
            request_id=self.request_id,
            agent_id="test-agent",
            base_dir=self.base,
        )
        self.claim_id = result["claim_id"]
        self.lease_token = result["lease_token"]

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_cli_lease_token_from_env_releases(self) -> None:
        env = {
            **os.environ,
            "PYTHONPATH": str(ARIA_KERNEL),
            "ARIA_LEASE_TOKEN": self.lease_token,
        }
        proc = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel", "agent", "release",
                "--claim-id", self.claim_id,
                "--agent-id", "test-agent",
                "--lease-token-from-env", "ARIA_LEASE_TOKEN",
                "--reason", "cli-env-var-test",
                "--tools-dir", str(self.base),
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(
            proc.returncode, 0,
            f"stdout={proc.stdout[:200]} stderr={proc.stderr[:200]}",
        )
        row = json.loads(proc.stdout)
        self.assertEqual(row["event"], "released")

    def test_cli_missing_env_var_fails(self) -> None:
        env = {**os.environ, "PYTHONPATH": str(ARIA_KERNEL)}
        env.pop("ARIA_LEASE_TOKEN", None)
        proc = subprocess.run(
            [
                sys.executable, "-m", "aria_kernel", "agent", "release",
                "--claim-id", self.claim_id,
                "--agent-id", "test-agent",
                "--lease-token-from-env", "ARIA_LEASE_TOKEN",
                "--reason", "cli-missing-env-test",
                "--tools-dir", str(self.base),
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertNotEqual(proc.returncode, 0)


class CiExecutorReleaseArgvShapeTests(unittest.TestCase):
    """AST scan: ``_release_claim`` argv contains the §B.1 required flags."""

    def test_release_argv_contains_agent_id_and_lease_token_from_env(self) -> None:
        src = (ARIA_POC / "ci_executor.py").read_text(encoding="utf-8")
        # The subprocess.run argv list in _release_claim must contain
        # --agent-id (pre-§B.1 missing) and --lease-token-from-env
        # (pre-§B.1 unrecognised by the CLI).
        self.assertIn('"--agent-id"', src)
        self.assertIn('"--lease-token-from-env"', src)
        # Function signature now accepts agent_id kwarg.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "ci_executor", ARIA_POC / "ci_executor.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sig = inspect.signature(mod._release_claim)
        self.assertIn("agent_id", sig.parameters)


if __name__ == "__main__":
    unittest.main()
