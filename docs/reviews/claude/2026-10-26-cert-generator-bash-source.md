# Certificate generator and BASH_SOURCE (2026-10-26)

Found while landing the Inter typography change (#2136): its CI run failed the required
`merge-gate` and `build-status` checks, and so does every run on `main` that makes the
invariants project affected. Verified against `origin/main` `20ff4f8a7`.

## DEPLOY-HIGH-030 — BASH_SOURCE is unset when the generator is evaluated

The certificate generator reads `BASH_SOURCE[0]` under `set -u`, which is unset when its
definitions are evaluated with `bash -c`, so the cert identity store invariants fail for every
change that makes the invariants project affected.

**Where:** `infrastructure/docker/scripts/generate-internal-certs.sh:7,10` and
`tests/invariants/production-cert-identity-store.spec.ts:120-127,206`.

**Root cause chain (each link verified):**

1. The script sets `set -euo pipefail` on line 7 and derives `SCRIPT_DIR` on line 10 from
   `${BASH_SOURCE[0]}` with no default.
2. The spec reads the script, cuts it at the generation boundary and evaluates the prefix with
   `/bin/bash -c`, so the shell functions can be called one at a time under test. In a `-c`
   string `BASH_SOURCE` has no element, and `set -u` turns the read into an error.
3. On bash 5.2.21 (this host) the error is `BASH_SOURCE[0]: unbound variable`, and the CI log
   of both runs below shows the same line; the harness then exits before any function runs,
   and three of the spec's 14 tests see that text instead of the message they assert.
4. `ci-affected` runs only the affected tests. A change that touches `tests/invariants` makes
   the invariants project affected, so the latent failure surfaces there: run `40367007947` on
   `main` and run `40349197785` of #2136 both fail the same three tests, and the required
   aggregates `merge-gate` and `build-status` follow.

**Fix (tier 1, impossible by construction):** `${BASH_SOURCE[0]:-$0}`. A script that is
executed behaves as before; one whose definitions are evaluated falls back to `$0`, so
`SCRIPT_DIR` resolves instead of aborting. No other deploy script reads `BASH_SOURCE` in the
evaluated prefix.

**Pinned by:** the 14 tests of `production-cert-identity-store.spec.ts`, which fail on the
unfixed script and pass on the fixed one (run locally on bash 5.2.21: 14 of 14).
