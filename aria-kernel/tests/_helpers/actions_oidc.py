"""A GitHub Actions run, as the kernel measures one (ARIA-HIGH-220).

The merge lane proves what it is with the Actions OIDC token: a JWT GitHub
signs, naming the run, the attempt, the runner environment and the workflow
file and ref the job runs. Tests stand up that run here: the job
environment GitHub sets, a token signed with a key this fixture generates,
and the JWKS lookup answering with that key's public half. The kernel's own
verification (``runner_attestation.verify_actions_oidc_token``: signature,
issuer, audience, expiry, then the run binding) runs unchanged; only the two
network seams — the token request and the JWKS fetch — are served here.
"""
from __future__ import annotations

import time
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from typing import Any, Iterator
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from aria_kernel.runner_attestation import (
    GITHUB_ACTIONS_OIDC_ISSUER,
    MERGE_LANE_WORKFLOW_PATH,
    MERGE_LANE_WORKFLOW_REF,
)


class ActionsRun:
    def __init__(
        self,
        *,
        repository: str = "okan/aqua",
        run_id: str = "4242",
        run_attempt: str = "1",
        runner_name: str = "GitHub Actions 7",
        runner_environment: str = "github-hosted",
        workflow_path: str = MERGE_LANE_WORKFLOW_PATH,
        workflow_ref: str = MERGE_LANE_WORKFLOW_REF,
    ) -> None:
        self.repository = repository
        self.run_id = run_id
        self.run_attempt = run_attempt
        self.runner_name = runner_name
        self.runner_environment = runner_environment
        self.workflow_path = workflow_path
        self.workflow_ref = workflow_ref
        self.signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.verifying_key = self.signing_key.public_key()
        self.claim_overrides: dict[str, Any] = {}

    def claims(self, *, audience: str) -> dict[str, Any]:
        now = int(time.time())
        claims = {
            "iss": GITHUB_ACTIONS_OIDC_ISSUER,
            "aud": audience,
            "sub": f"repo:{self.repository}:ref:{self.workflow_ref}",
            "iat": now - 5,
            "nbf": now - 5,
            "exp": now + 300,
            "repository": self.repository,
            "run_id": self.run_id,
            "run_attempt": self.run_attempt,
            "runner_environment": self.runner_environment,
            "job_workflow_ref": f"{self.repository}/{self.workflow_path}@{self.workflow_ref}",
            "workflow_ref": f"{self.repository}/{self.workflow_path}@{self.workflow_ref}",
            "ref": self.workflow_ref,
        }
        claims.update(self.claim_overrides)
        return claims

    def token(self, *, audience: str, signing_key: Any = None) -> str:
        return jwt.encode(
            self.claims(audience=audience),
            signing_key or self.signing_key,
            algorithm="RS256",
            headers={"kid": "fixture-key"},
        )

    def environment(self) -> dict[str, str]:
        return {
            "RUNNER_ENVIRONMENT": self.runner_environment,
            "GITHUB_RUN_ID": self.run_id,
            "GITHUB_RUN_ATTEMPT": self.run_attempt,
            "RUNNER_NAME": self.runner_name,
            "GITHUB_REPOSITORY": self.repository,
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://actions.invalid/token?api-version=2.0",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "fixture-request-token",
        }

    @contextmanager
    def active(self, *, signing_key: Any = None) -> Iterator["ActionsRun"]:
        """Run the enclosed code inside this Actions job."""
        jwks = SimpleNamespace(
            get_signing_key_from_jwt=lambda token: SimpleNamespace(key=self.verifying_key),
        )
        with ExitStack() as stack:
            stack.enter_context(patch.dict("os.environ", self.environment()))
            stack.enter_context(patch(
                "aria_kernel.runner_attestation.fetch_actions_oidc_token",
                side_effect=lambda *, audience: self.token(audience=audience, signing_key=signing_key),
            ))
            stack.enter_context(patch(
                "aria_kernel.runner_attestation._github_jwks_client", return_value=jwks,
            ))
            yield self


@contextmanager
def merge_lane_job(**run_overrides: Any) -> Iterator[ActionsRun]:
    """Inside the merge-lane job, for runner tests about something else.

    The grant, profile and freeze tests drive ``RealAutoMergeRunner`` with
    no readiness-claim ledger. The lane identity here is the real, verified
    one (the runner decides to execute from it). Only the per-candidate
    attestation row is not recorded (``auto_merge_runners._attest_candidate``).
    ``test_merge_lane_attestation`` covers that row end to end.
    """
    run = ActionsRun(**run_overrides)
    with run.active(), patch("aria_kernel.auto_merge_runners._attest_candidate", return_value={}):
        yield run
