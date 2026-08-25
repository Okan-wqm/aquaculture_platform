# Production Security Audit — Release Blockers

**Date:** 2026-08-25
**Scope:** Active DigitalOcean droplet deployment, application trust boundaries, dependency graph, and edge command ingestion.
**Decision:** NO-GO until every CRITICAL/HIGH finding in this report is either resolved and verified or remains operationally isolated.

## RUST-HIGH-003 — MQTT enforcing mode accepts unsigned legacy commands and malformed timestamps

**Severity:** HIGH
**State:** IN-PROGRESS

`CommandHandler::handle_message` treats `AdapterOutcome::NotEnvelopeFormat` as permission to parse a legacy `CommandMessage` even when `SignatureMode::Enforcing`. The no-tenant provisioning branch also selects legacy parsing unconditionally. An unsigned legacy payload can therefore bypass the mode that operators selected specifically to require signed envelopes.

The same dispatch path applies the replay window only when `DateTime::parse_from_rfc3339` succeeds. A malformed timestamp skips freshness validation and proceeds to deduplication and command execution.

Evidence:

- `sens-api-gateway/src/commands/mqtt_dispatch.rs:135-185`
- `sens-api-gateway/src/commands/mqtt_dispatch.rs:210-229`
- `sens-api-gateway/src/commands/envelope_adapter.rs:101-116`

Required closure:

- Enforcing mode accepts only a verified `CommandEnvelope`; legacy, malformed, and unprovisioned-tenant inputs fail closed before deduplication.
- Disabled and Permissive modes retain the documented legacy compatibility path.
- Every legacy timestamp must parse as RFC3339 and fit the configured past/future replay window before deduplication or execution.
- Executable tests cover every mode and timestamp boundary.

## ADMIN-HIGH-005 — Admin sort fields are interpolated into TypeORM SQL identifiers

**Severity:** HIGH
**State:** IN-PROGRESS

Three admin service query builders construct `ORDER BY` identifiers with caller-controlled `sortBy` strings. The activity and audit HTTP DTOs accept any string, while the error controller's string-literal union disappears at runtime. Direct service callers can also bypass controller validation. TypeORM parameters cannot bind SQL identifiers, so these values cross into query syntax rather than data parameters.

Evidence:

- `apps/admin-api-service/src/security/services/activity-logging.service.ts:661`
- `apps/admin-api-service/src/security/services/audit-trail.service.ts:283`
- `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:370`
- `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:254`

Required closure:

- Define readonly field allowlists and alias-specific complete-column maps; no caller value is interpolated into an identifier.
- Enforce the same field vocabulary with runtime DTO validation at every HTTP boundary.
- Normalize field and direction again inside each service so non-HTTP callers fail safely to documented defaults.
- Executable tests prove malicious identifiers never reach `orderBy`, valid fields map exactly, directions normalize safely, and filters remain bound parameters.

## SUPPLY-CRITICAL-002 — JavaScript runtime and build graphs contain known advisories hidden by CI policy

**Severity:** CRITICAL
**State:** IN-PROGRESS

At the discovery snapshot (`6328f364d0d6988486cc0361fa2ff55b64a07e3a`,
2026-08-25), the root lock resolved Vitest 3.2.4, which is affected by a critical
arbitrary-file read and execution advisory when its UI server listens. Nx 22.7.1,
`@module-federation/vite` 1.16.8, and `vite-plugin-dts` 3.9.1 pulled high-severity
path-traversal, archive/resource-exhaustion, HTTP client, and ReDoS advisories into
the repository's build and CI trust boundary.

That production graph independently resolved DOMPurify 3.4.12 and React Router
6.30.4, exposing an XSS sanitizer bypass and open-redirect/XSS advisories. At the
same snapshot, root `npm audit --omit=dev` reported three moderate vulnerabilities,
while the full graph reported two critical, ten high, and twenty-eight moderate
vulnerabilities. Both primary workflows ran only
`npm audit --audit-level=high --omit=dev`, so the production issues fell below the
threshold and the vulnerable development toolchain was excluded entirely.

Evidence:

- `package.json:280-350`
- `package-lock.json:9628-9640`
- `package-lock.json:34824-34829`
- `package-lock.json:41906-41934`
- `.github/workflows/ci-affected.yml:1033-1074`
- `.github/workflows/ci-full.yml:431-439`

Required closure:

- Upgrade the exact-coupled Nx and Vitest package families to advisory-fixed patch releases, including lock metadata and the invariant that pins the Vitest coverage provider to the runner.
- Upgrade every federated app to an advisory-fixed Module Federation Vite release and both declaration-generation consumers to a fixed `vite-plugin-dts` release.
- Upgrade DOMPurify and every React Router consumer atomically, including the federation version SSoT and Aquamobil's standalone lock.
- Make CI fail on moderate production advisories and on high/critical full-graph advisories; preserve npm's original exit status and publish source maps for both graphs.
- Apply `--ignore-scripts --no-fund` consistently to the remaining db-migration workflow install.
- Executable invariant tests prevent vulnerable version/policy regressions, focused frontend builds/tests pass, and fresh audits report zero production vulnerabilities plus zero high/critical full-graph vulnerabilities.

Remediation evidence (2026-08-25):

- The exact Nx family resolves at 22.7.8, Vitest and its V8 coverage provider at
  3.2.7, Module Federation Vite at 1.20.8, both declaration-generation
  consumers at `vite-plugin-dts` 4.5.4, DOMPurify at 3.4.14, and every React
  Router consumer at 7.18.2. The federation SSoT shares both `react-router` and
  `react-router-dom` as exact strict singletons.
- The root lock is byte-stable at SHA-256
  `1b9dca0c7b6d3412318e03513cbf2898a6a501145a2c93334f8a91b6f3ea7b2c`;
  Aquamobil's standalone lock is byte-stable at SHA-256
  `ee6a904ac9a7214bf1aeac525a264245b6c8d283f2275129752e153d2adeeb80`.
  Strict `npm ls` confirms API Extractor's `diff` 8.0.3 and ts-node's isolated
  `diff` 4.0.4 graph without invalid or extraneous packages.
- Fresh root production audit at `moderate --omit=dev` and both Aquamobil
  production/full audits report zero vulnerabilities. The root full audit at
  `high` reports zero low/high/critical findings; seven dev-only moderate
  findings remain in the Testcontainers 12-major and optional Vue peer chains.
  They do not ship in either production graph and cannot hide a high/critical
  regression under the new full-graph CI threshold.
- Both primary workflows capture all four audit and four source-map exit
  statuses before failing, upload all eight artifacts under `always()`, and
  fail when an artifact is missing. The migration check installs with lifecycle
  scripts disabled and funding output suppressed.
- The dependency, workflow, federation, Router source, shared-singleton, and
  enterprise debt-plan invariants pass 45/45;
  shared UI passes 413/413 tests with coverage. Focused redirect, MFA,
  transition, and nested-route regressions pass, and the shared UI, shell,
  sensor, hydroponics, and Aquamobil TypeScript programs complete successfully.
- Production builds pass for shared UI, node-components, shell, all eight
  federated remotes, and standalone Aquamobil (including its service worker).
  Shared UI's emitted declaration graph contains the Router 7 declarative
  navigation augmentation through its public type entrypoint.
