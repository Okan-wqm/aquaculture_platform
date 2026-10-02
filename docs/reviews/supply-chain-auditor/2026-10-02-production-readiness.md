# Dependency and supply-chain risk — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `supply-chain-auditor` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | npm/Cargo audit gates, exceptions, production base images, licences, image signing |
| Verdict | **NOT READY (supply-chain view)** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The reviewer could not name the advisory that turns `security-audit` red: its tools were read-only
with no shell or network, so it could not run `npm audit` or open the CI logs. The cause below
comes from reading the gate code.

## Why `security-audit` is red

- **Not expired exceptions.** Both entries expire 2026-10-16, after today
  (`scripts/ci/npm-audit-exceptions.json:7,31`); the date check passes.
- **Not a script bug.** `npm-audit-gate.mjs` exits 1 only when `assess()` (lines 141-186) finds an
  advisory at or above the level that has no exception matching its GHSA id, scope and package. A
  new advisory hit an unchanged lockfile, the same pattern as SUPPLY-HIGH-001/005/006/009/013.
- Likely entry points:
  - The root-production leg runs at `moderate` and contains vite 7.3.5, esbuild and rollup,
    because `vite-plugin-svgr` is a production dependency (`package.json:279`).
  - nx 22.7.8 exact-pins about 100 transitive packages (`package-lock.json:34255-34360`); a new
    GHSA in any of them spreads to 15 `@nx/*` packages that the GHSA-specific exceptions do not
    cover.
- **It stays red on every push.** On push the range is `deployed/development..HEAD`
  (`ci-affected.yml:63-83`). That tag does not move while deploy is skipped, so the audit re-runs
  on each main push.
- **Minimal fix: upgrade or override, do not renew.** Read the gate's stderr or the
  `npm-audit-source-map-<run>` artifact to get the package and GHSA. If a patched version exists
  in the same major, upgrade or add an override; the gate's own rule forbids excepting a fixable
  advisory. Only if no fix exists: add a dated exception, raise the ratchet
  (`npm-audit-exception-ssot.spec.ts:47`) and add a registry finding.

## Blockers

- **B1.** The red gate above blocks deploy.
- **B2. Rust ignore deadline already passed.** RUSTSEC-2026-0173 had deadline 2026-10-01
  (`sens-api-gateway/deny.toml:80`, `.cargo/audit.toml:89`). `check-advisory-ignore-sync.ts:170`
  now fails, so `rust-ci.yml:86` goes red on its next path trigger. `proc-macro-error2` is still
  in `Cargo.lock:2921`. Renew with a new dated deadline; it is build-time only.
- **B3. npm exceptions expire 2026-10-16.** The stated reason ("SemVer-major 22.6.4 bump") is a
  downgrade from 22.7.8. The root package is smol-toml 1.6.1, exact-pinned by nx
  (`package-lock.json:34342`), the same shape as adm-zip; an `overrides` entry for smol-toml
  likely clears it (patched range unverified).

## Major

- **Unpinned, outdated production base images.**
  - Backend and db-migrate images use `node:22.13.1-bookworm-slim` by tag only
    (`Dockerfile.backend.simple:20`, `Dockerfile.db-migrate:25`). This Node predates the May-2025
    and Jan-2026 security releases.
  - The digest-pinned `Dockerfile.backend` is not the one deploy uses
    (`select-deployment-scope.ts:197-200`).
  - Frontends use `nginx:1.27.3-alpine` by tag (`Dockerfile.microfrontend.simple:8`).
- **`docker-compose.droplet.yml` images.**
  - `nats:2.10.24` (line 592) is affected by CVE-2025-30215 (critical, fixed in 2.10.27).
  - `redis:7-alpine` is a floating tag (lines 504, 563).
  - MinIO `RELEASE.2025-04-03` (line 675) is likely affected by CVE-2025-62506 (medium
    confidence).
- **Trivy gates nothing before deploy.** The fs scan uses `exit-code: 0`. The image scan is weekly
  and covers only `gateway-api:latest` (`security-trivy.yml:39,54,79`).
- **No signing, SBOM or provenance on platform images** (`deploy-digitalocean.yml:905-929`,
  `build-images.yml:249`). Only sensor-ingestion and the edge agent are signed.
- **The npm gate passes when the audit fails.** If `npm audit` errors, the JSON has no
  `vulnerabilities`, so the gate reports clean (`npm-audit-gate.mjs:143`); the audit step also
  ignores npm's exit code (`ci-affected.yml:1503`).
- **Licences needing legal sign-off.**
  - `react-leaflet` is Hippocratic-2.1 (not OSI-approved, has a termination clause) and Apollo
    federation is Elastic-2.0. Both are approved only in the script
    (`check-production-licenses.mjs:39-47`); that gate runs weekly only (`ci-full.yml:581`) and
    skips the AquaMobil lock.
  - No GPL/AGPL/SSPL in npm production dependencies. The LGPL packages (sharp-libvips, @zenfs) are
    dynamically loaded on the backend.

## Minor

- Snyk is manual-only, with no token configured (`security-snyk.yml:9`).
- Dependabot has no docker ecosystem and excludes `sens-api-gateway` Cargo.
- About 37 npm overrides. React and the Vite toolchain end up in every backend image.
- Root `package.json:5` says `"MIT"` for a proprietary repository.
- SUPPLY-HIGH-011/012 have `deadline: null` in the registry.

## Verified OK

- Every Actions `uses:` is pinned to a 40-character SHA.
- Root `deny.toml` and `audit.toml` ignore lists are empty.
- Gateway crates are current (rustls 0.23.45, tokio 1.52.1, ring 0.17.14).
- All lockfiles are committed.

## Not verified

- Live npm audit and cargo audit output, the failing GHSA id and scope, Trivy results, the patched
  range for GHSA-7w5x, and whether `rust-ci` is a required check.

## Registry entries

This review appended 8 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| SUPPLY-HIGH-022 | HIGH | CI - Affected security-audit fails at "Gate npm audit on reviewed exceptions" on every main push, turning build-status and development-delivery-status red and skipping deploy-development; the offending advisory is not yet identified and the exceptions file is not the cause because both entries expire 2026-10-16 |
| SUPPLY-HIGH-023 | HIGH | The Rust advisory ignore for RUSTSEC-2026-0173 had a deadline of 2026-10-01 that has passed, so check-advisory-ignore-sync now fails and rust-ci.yml goes red on its next path trigger while proc-macro-error2 is still in Cargo.lock |
| SUPPLY-HIGH-025 | HIGH | Production images use unpinned, outdated bases: backend and db-migrate use node:22.13.1-bookworm-slim by tag (the digest-pinned Dockerfile.backend is not what deploy uses), frontends use nginx:1.27.3-alpine by tag, and the droplet compose runs nats:2.10.24 (CVE-2025-30215, fixed in 2.10.27), floating redis:7-alpine and a MinIO release from 2025-04 |
| SUPPLY-MEDIUM-024 | MEDIUM | Both npm audit exceptions expire 2026-10-16 and their stated reason ("SemVer-major 22.6.4 bump") describes a downgrade from the installed nx 22.7.8; the root smol-toml 1.6.1 is exact-pinned by nx like adm-zip, so an overrides entry likely clears it instead of renewing |
| SUPPLY-MEDIUM-026 | MEDIUM | Trivy gates nothing before deploy (the fs scan uses exit-code 0 and the weekly image scan covers only gateway-api:latest), and platform images ship without signing, SBOM or provenance (only sensor-ingestion and the edge agent are signed) |
| SUPPLY-MEDIUM-027 | MEDIUM | The npm audit gate fails open: if npm audit itself errors the JSON has no vulnerabilities key and npm-audit-gate.mjs reports clean, and the audit step ignores npm's exit code |
| SUPPLY-MEDIUM-028 | MEDIUM | Two production dependencies need legal sign-off but are approved only inside a script (react-leaflet is Hippocratic-2.1, Apollo federation is Elastic-2.0), and the licence gate runs weekly only and skips the AquaMobil lockfile |
| SUPPLY-LOW-029 | LOW | Supply-chain hygiene gaps: Snyk is manual-only with no token, Dependabot has no docker ecosystem and excludes sens-api-gateway Cargo, root package.json declares MIT for a proprietary repository, and SUPPLY-HIGH-011/012 carry a null deadline |
