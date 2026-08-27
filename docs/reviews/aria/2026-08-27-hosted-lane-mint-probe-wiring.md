# ARIA review — 2026-08-27: hosted lanes cannot mint or probe (undeclared PyJWT, unwired probe token)

Two independent root causes kept every hosted ARIA lane that touches the
GitHub App red after PR #1329 fixed the mint call signature:

## Measured facts

- `finding-state-sweep` run 32943402324 (2026-08-26) died at the mint step
  with `RuntimeError: mint_installation_token Mode A requires PyJWT (pip
install PyJWT[crypto]); not installed.` The kernel's `pyproject.toml`
  declared only `pyyaml`; `gh_token_factory.py` imports `jwt` lazily in
  Mode A. The operator droplet happens to have PyJWT system-wide, which is
  why local verification of the #1329 fix passed — the dependency was
  never declared anywhere the setup-aria-kernel action installs from.
- `aria-readiness-claim` run 33022651661 (2026-08-26) died inside
  `produce-claim` with `branch_protection_probe_no_payload:
gh_token_absent`: the assemble step exports no `GH_TOKEN`, and
  `preflight.probe_branch_protection` fails closed without one.

## ARIA-MEDIUM-021 — hosted Mode-A lanes die on an undeclared PyJWT and an unwired probe token

Any hosted lane that mints an installation token or probes branch
protection cannot succeed: the import fails (PyJWT undeclared) or the
probe reads an absent env (GH_TOKEN never exported to the assemble step).

## Fix

- `aria-kernel/pyproject.toml` declares `pyjwt[crypto]>=2.8` — the single
  SSoT path the `setup-aria-kernel` action installs from, so every
  kernel-importing lane gets it automatically. Same defect class,
  measured on run 33056211686 once the raised timeout let the hosted
  suite reach discovery: `pytest` is also declared now, because three
  test modules import it at module scope and `unittest discover` fails
  at import on any host without it.
- Declaring the dependency only removed the import error: unittest
  discovery collects TestCase classes only, so the three pytest-style
  modules contributed ZERO executed tests — 34 tests measured invisible
  to every lane and to the pre-push gate (`pytest --collect-only`:
  34; `unittest <module>`: "NO TESTS RAN"). The suite now runs through
  `scripts/ci/aria-suite-run.sh`, the single definition that runs the
  unittest half AND pytest over exactly the modules that import pytest
  at module scope (discovered by grep, not a hand-kept list). All four
  former call sites (aria-kernel, aria-kernel-fast, `npm run
aria:test:unit`, the pre-push gate) now delegate to it.
- `aria-readiness-claim.yml` assemble step mints the installation token
  and exports it as `GH_TOKEN` for the branch-protection probe.

## Operator dependency (outside code)

The App's permission set does not include **Administration: read-only**,
so even with a token the probe's `GET /branches/{branch}/protection`
will 403 until the operator ticks that permission on the App settings
page. Until then the lane fails with the probe's stderr (honest,
fail-closed) instead of `gh_token_absent`.
