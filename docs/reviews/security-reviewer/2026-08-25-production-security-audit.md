# Production Security Audit — Release Blockers

**Date:** 2026-08-25
**Scope:** Active DigitalOcean droplet deployment, application trust boundaries,
dependency graph,
and edge command ingestion.
**Decision:** NO-GO until every CRITICAL/HIGH finding in this report is either
resolved and verified
or remains operationally isolated.

## RUST-HIGH-003 — MQTT enforcing mode accepts unsigned legacy commands and

malformed timestamps

**Severity:** HIGH
**State:** IN-PROGRESS

`CommandHandler::handle_message` treats `AdapterOutcome::NotEnvelopeFormat` as
permission to parse a
legacy `CommandMessage` even when `SignatureMode::Enforcing`. The no-tenant
provisioning branch also
selects legacy parsing unconditionally. An unsigned legacy payload can therefore
bypass the mode
that operators selected specifically to require signed envelopes.

The same dispatch path applies the replay window only when
`DateTime::parse_from_rfc3339` succeeds.
A malformed timestamp skips freshness validation and proceeds to deduplication
and command
execution.

Evidence:

- `sens-api-gateway/src/commands/mqtt_dispatch.rs:135-185`
- `sens-api-gateway/src/commands/mqtt_dispatch.rs:210-229`
- `sens-api-gateway/src/commands/envelope_adapter.rs:101-116`

Required closure:

- Enforcing mode accepts only a verified `CommandEnvelope`; legacy, malformed,
  and unprovisioned-
  tenant inputs fail closed before deduplication.
- Disabled and Permissive modes retain the documented legacy compatibility path.
- Every legacy timestamp must parse as RFC3339 and fit the configured
  past/future replay window
  before deduplication or execution.
- Executable tests cover every mode and timestamp boundary.

## ADMIN-HIGH-005 — Admin sort fields are interpolated into TypeORM SQL

identifiers

**Severity:** HIGH
**State:** IN-PROGRESS

Three admin service query builders construct `ORDER BY` identifiers with caller-
controlled `sortBy`
strings. The activity and audit HTTP DTOs accept any string, while the error
controller's string-
literal union disappears at runtime. Direct service callers can also bypass
controller validation.
TypeORM parameters cannot bind SQL identifiers, so these values cross into query
syntax rather than
data parameters.

Evidence:

- `apps/admin-api-service/src/security/services/activity-logging.service.ts:661`
- `apps/admin-api-service/src/security/services/audit-trail.service.ts:283`
- `apps/admin-api-service/src/system-management/services/error-
tracking.service.ts:370`
- `apps/admin-api-service/src/system-management/controllers/error-
tracking.controller.ts:254`

Required closure:

- Define readonly field allowlists and alias-specific complete-column maps; no
  caller value is
  interpolated into an identifier.
- Enforce the same field vocabulary with runtime DTO validation at every HTTP
  boundary.
- Normalize field and direction again inside each service so non-HTTP callers
  fail safely to
  documented defaults.
- Executable tests prove malicious identifiers never reach `orderBy`, valid
  fields map exactly,
  directions normalize safely, and filters remain bound parameters.

## SUPPLY-CRITICAL-002 — JavaScript runtime and build graphs contain known

advisories hidden by CI
policy

**Severity:** CRITICAL
**State:** IN-PROGRESS

At the discovery snapshot (`6328f364d0d6988486cc0361fa2ff55b64a07e3a`,
2026-08-25), the root lock resolved Vitest 3.2.4, which is affected by a
critical
arbitrary-file read and execution advisory when its UI server listens. Nx
22.7.1,
`@module-federation/vite` 1.16.8, and `vite-plugin-dts` 3.9.1 pulled high-
severity
path-traversal, archive/resource-exhaustion, HTTP client, and ReDoS advisories
into
the repository's build and CI trust boundary.

That production graph independently resolved DOMPurify 3.4.12 and React Router
6.30.4, exposing an XSS sanitizer bypass and open-redirect/XSS advisories. At
the
same snapshot, root `npm audit --omit=dev` reported three moderate
vulnerabilities,
while the full graph reported two critical, ten high, and twenty-eight moderate
vulnerabilities. Both primary workflows ran only
`npm audit --audit-level=high --omit=dev`, so the production issues fell below
the
threshold and the vulnerable development toolchain was excluded entirely.

Evidence:

- `package.json:280-350`
- `package-lock.json:9628-9640`
- `package-lock.json:34824-34829`
- `package-lock.json:41906-41934`
- `.github/workflows/ci-affected.yml:1033-1074`
- `.github/workflows/ci-full.yml:431-439`

Required closure:

- Upgrade the exact-coupled Nx and Vitest package families to advisory-fixed
  patch releases,
  including lock metadata and the invariant that pins the Vitest coverage provider
  to the runner.
- Upgrade every federated app to an advisory-fixed Module Federation Vite
  release and both
  declaration-generation consumers to a fixed `vite-plugin-dts` release.
- Upgrade DOMPurify and every React Router consumer atomically, including the
  federation version
  SSoT and Aquamobil's standalone lock.
- Make CI fail on moderate production advisories and on high/critical full-graph
  advisories;
  preserve npm's original exit status and publish source maps for both graphs.
- Apply `--ignore-scripts --no-fund` consistently to the remaining db-migration
  workflow install.
- Executable invariant tests prevent vulnerable version/policy regressions,
  focused frontend
  builds/tests pass, and fresh audits report zero production vulnerabilities plus
  zero high/critical
  full-graph vulnerabilities.

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
- Both primary workflows capture the root, Aquamobil, and standalone E2E
  production/full audit statuses plus every source-map status before failing,
  upload all twelve artifacts under `always()`, and fail when an artifact is
  missing. The migration check installs with lifecycle scripts disabled and
  funding output suppressed.
- The dependency, workflow, federation, Router source, shared-singleton, and
  enterprise debt-plan invariants pass 45/45;
  shared UI passes 413/413 tests with coverage. Focused redirect, MFA,
  transition, and nested-route regressions pass, and the shared UI, shell,
  sensor, hydroponics, and Aquamobil TypeScript programs complete successfully.
- Production builds pass for shared UI, node-components, shell, all eight
  federated remotes, and standalone Aquamobil (including its service worker).
  Shared UI's emitted declaration graph contains the Router 7 declarative
  navigation augmentation through its public type entrypoint.

## SUPPLY-HIGH-003 — Standalone dependency locks bypass release auditing and

retain known high-
severity advisories

**Severity:** HIGH
**State:** IN-PROGRESS

Post-push reconciliation at snapshot
`fdd1767ebc5dc7efe49253a45180a20cced32a20` expanded the dependency inventory
beyond the root npm workspace and Aquamobil lock that `SUPPLY-CRITICAL-002`
covered. The standalone E2E graph reported three high-severity vulnerable
package families and one low-severity family. They are development-only and do
not ship in a production image, but they execute repository-controlled input in
CI. Neither primary workflow audited that lock, `/e2e` had no Dependabot entry,
and an E2E-only dependency PR did not set `has_changes=true` in CI Affected.

Final independent review also proved that the root npm entry cannot maintain
Aquamobil's nested production lock: its Dockerfile copies that lock into an
isolated build and runs `npm ci`, while Dependabot scopes lock ownership to the
configured manifest directory. The graph was already audited and clean, but it
had no automated lock-update owner and neither primary workflow proved the
nested manifest/lock pair was installable before treating its audit as evidence.

Two nested `pnpm-lock.yaml` files created a second package-manager authority
inside npm workspace members. The stale MCP lock alone reported eight high,
twenty-nine moderate, and four low advisories even though production and CI use
the safe root npm graph. The lockfile-coverage invariant recognized only
`package-lock.json` and `Cargo.lock`, so both pnpm locks were invisible to the
guard. MCP is disabled by default, no production compose file enables it, and
the live farm image contains no MCP source or build output; this is therefore a
supply-chain authority defect rather than an exposed production MCP runtime.

Fresh RustSec data also added `RUSTSEC-2026-0258` for `h2 0.4.13`, which made
both mandatory root and edge audits fail. The committed fuzz lock separately
retained `rustls-webpki 0.102.8` with one high, one moderate, and two low
advisories because its standalone workspace did not inherit the parent
`rumqttc` patch. The fuzz target does not ship, but a committed high advisory is
incompatible with a repository-level release attestation.

Required closure:

- Raise the E2E direct and transitive floors to patched releases, prove both
  production and full audits are clean, add `/e2e` Dependabot coverage, and
  make both primary workflows preserve and publish its audit/map statuses.
- Give the standalone Aquamobil production lock explicit resolution-update
  ownership without competing with root-workspace manifest updates, and make
  both primary workflows fail on standalone manifest/lock drift.
- Route E2E-only changes through CI Affected so the new audit can enforce
  itself.
- Remove nested pnpm locks, retain root npm as the sole JavaScript dependency
  authority, and make an executable invariant reject future pnpm lock drift.
- Update root and edge `h2`, the root `cmov` and `serde_with` resolutions, and
  make the fuzz workspace inherit the local patched `rumqttc`; prove root,
  edge, and fuzz audit graphs have no active vulnerability.
- Keep optional-disabled OpenTelemetry and license-enforcement dependency
  families out of release profiles until the coordinated `ORPHAN-MEDIUM-140`
  upgrade and `RUST-CVE-002` claim-validation migration land. They remain
  explicit residual medium risk, not silently represented as
  zero-all-advisories.

Remediation evidence (2026-08-25):

- E2E resolves `@babel/core 7.29.7`, `brace-expansion 1.1.18`,
  `fast-uri 3.1.6`, and `js-yaml 3.15.1/4.3.1`; clean install succeeds and both
  its
  production and full audits report zero vulnerabilities.
- Both primary workflows now validate the Aquamobil and E2E manifest/lock pairs,
  capture all six audit and six source-map exit statuses, upload all twelve
  artifacts even on failure, and CI Affected treats `e2e/**` as control-plane
  input. Dependabot independently watches `/e2e`; an Aquamobil `lockfile-only`
  entry refreshes the production Docker lock without editing the shared
  workspace manifest, with one grouped update PR allowed at a time.
- The duplicate pnpm locks are removed. The lockfile invariant recognizes pnpm
  files, requires npm to remain the only JavaScript lock authority, verifies
  the standalone fuzz audit gate, and passes together with the expanded
  dependency/workflow invariant (23/23 focused assertions). The dependency
  policy gate also skips tracked paths already removed from the working tree,
  so intentional authority deletion can be verified before staging.
- Root and edge resolve `h2 0.4.16`; root also resolves `cmov 0.5.4` and
  `serde_with`/macros 3.21.0. Fuzz resolves only `rustls-webpki 0.103.13` and
  `time 0.3.47` through the local `rumqttc` patch. Root, edge, and fuzz audits
  report zero active vulnerabilities, and edge CI now audits the committed fuzz
  lock explicitly. Locked checks pass for root `sensor-ingestion` release, the
  edge `scada-display` release profile, and every fuzz binary.
- The edge release still carries the explicitly tracked `bincode 1.3.3`
  unmaintained warning (`RUSTSEC-2025-0141`, tracked by `RUST-MEDIUM-004`),
  whose replacement requires a coordinated wire-format migration. The
  non-shipping fuzz graph also reports `spin 0.9.8` as yanked. Neither is an
  active vulnerability or an unrecorded critical/high release exception.
- Repository-level Dependabot automated security fixes were disabled at this
  snapshot. Enabling them while the default branch still reports its pre-merge
  alert set could create competing PRs, so this patch does not mutate that
  external setting. Weekly full CI still audits every deployed npm graph
  fail-closed; enabling automated fixes should be coordinated after this branch
  merges and GitHub reindexes the remediated locks.

## RUST-MEDIUM-004 — unmaintained edge serialization dependencies require coordinated replacement

- **Severity:** MEDIUM
- **State:** OPEN
- **Owner:** security-reviewer
- **Deadline:** 2026-12-01

The 2026-09-02 deadline review found that `RUSTSEC-2024-0388` was a stale
exception: `derivative` is absent from the committed edge lockfile, so the
exception was removed from both TOML policies and every workflow audit command.

Two informational, unmaintained advisories remain. `bincode 1.3.3` is a direct
dependency whose persisted bytes are used by the audit HMAC chain and RBAC
manifest; replacing it changes the wire representation and requires a versioned
data migration. `atomic-polyfill 1.0.3` is reachable only through the optional
OPC UA graph (`async-opcua -> postcard -> heapless`). The latest upstream
`async-opcua 0.19.0` lockfile still contains the same transitive package. RustSec
lists no patched version for either advisory and classifies both as
unmaintained, not active vulnerabilities.

Required closure:

- Define and test a versioned replacement format for every persisted bincode
  payload before changing the encoder.
- Remove `atomic-polyfill` by upgrading to an upstream OPC UA/postcard graph
  that no longer enables `heapless-cas`, or maintain a reviewed local fork if
  upstream remains blocked.
- Remove each ignore from `deny.toml`, `audit.toml`, and all workflow audit
  commands in the same commit when its package leaves the lockfile.
- Re-evaluate both dependency graphs no later than 2026-12-01.
