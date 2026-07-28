# CI Full dependency, license and scanner contract

**Date:** 2026-07-27
**Scope:** production dependency classification, CI Full security and license jobs
**Baseline:** `bdaf00bf`

## INFRA-HIGH-082 — build-only packages contaminated the production graph

`tools/eslint-rules` was listed as a workspace but was not declared as a root dev dependency.
npm therefore treated its runtime dependency on `@typescript-eslint/utils` and the required
ESLint peer as production. The affected chain is a build tool only: the repository loads the
plugin from `eslint.config.mjs`, while application containers never invoke ESLint.

The fix removes the tool from the production workspace set and declares the private package as
an explicit root `file:` dev dependency. The plugin retains its honest dependency and peer
metadata. The resulting lockfile marks the complete lint chain `dev: true`.

The root also declared `@anthropic-ai/claude-agent-sdk`, including platform packages with a
custom license, but no source file imported it. `apps/ai-service` uses `@anthropic-ai/sdk`.
The unused Agent SDK is removed, and the AI knowledge invariant now anchors the dependency that
the application actually imports.

## INFRA-HIGH-083 — required CI depended on unavailable and nondeterministic controls

CI Full invoked Snyk even though the dedicated Snyk workflow records that `SNYK_TOKEN` is not
configured and is manual-only. That credential-dependent scan is removed from required CI; the
manual workflow remains available when its credential and ownership are established.

The license job used an unversioned `npx license-checker` download and a blanket allowlist. It
stopped at the first failure and did not describe the production lock: it included the private
UNLICENSED compatibility shim, omitted licenses already present in Apollo, Sharp and mapping
dependencies, and scanned build-only packages.

`scripts/ci/check-production-licenses.mjs` now reads the committed lockfile and checks only
external packages that npm marks for production. Common SPDX expressions are policy inputs.
Restrictive/non-standard licenses and legacy packages missing modern metadata are exact
package-version exceptions, so any upgrade or new license fails closed and requires review.
Stale exceptions fail too.

## Verification contract

- `npm audit --audit-level=high --omit=dev`: zero high or critical findings.
- `npm run gates:production-licenses`: every locked production external package classified.
- `@anthropic-ai/claude-agent-sdk`: absent from source manifest and lockfile.
- `eslint`, `@typescript-eslint/utils` and their vulnerable lint-only chain: `dev: true`.
- Snyk: absent from CI Full; retained in the manual security workflow.
