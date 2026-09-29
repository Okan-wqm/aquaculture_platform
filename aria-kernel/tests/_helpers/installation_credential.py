"""ARIA-CRITICAL-246 — the credential a lane's GitHub write runs on, as a fixture.

WHY: ``aria_kernel.github_writes.run_gh_write`` runs a write only on a GitHub
App installation token, which GitHub authors as a Bot. Every ARIA lane holds
one: the job token (``github.token``) or an App token it minted. A test that
drives a write the lane makes therefore models that credential. Leaving it out
models the operator's terminal instead, where ``gh`` falls back to its stored
login and the door refuses.

WHAT: one installation-shaped value (``ghs_`` prefix, GitHub's token format)
and the environment that carries it. The value is not a credential and is sent
nowhere: every test that uses it fakes ``gh``.
"""
from __future__ import annotations

INSTALLATION_TOKEN = "ghs_fixture_installation_token"

# The environment a lane's `gh` write runs in: GH_TOKEN is the one gh reads first.
LANE_CREDENTIAL_ENV: dict[str, str] = {"GH_TOKEN": INSTALLATION_TOKEN}

__all__ = ("INSTALLATION_TOKEN", "LANE_CREDENTIAL_ENV")
