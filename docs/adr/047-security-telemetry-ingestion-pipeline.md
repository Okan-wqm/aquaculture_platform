# ADR-047: Security-Telemetry Ingestion Pipeline (admin-api security monitoring)

## Status

**Accepted (Part A) / Proposed (Part B).**

- **Part A — honest health-score** is implemented (ADMIN-CRITICAL-016 / APA-240):
  the SUPER_ADMIN security dashboard no longer fabricates a green "healthy"
  score over empty telemetry tables; it renders "No telemetry" via a
  liveness `dataStatus`. The fabricated threat-feed cron is deleted.
- **Part B — reviving the telemetry supply chain** (the actual ingestion
  pipeline) is a **tracked, not-yet-implemented** cross-service change. It
  needs the NATS event backbone + a Docker-backed integration test the PR lane
  does not run, so this ADR records the architecture-of-record. Owner:
  admin-panel remediation lane. Deadline: Phase 2 (telemetry & security truth)
  of `docs/plans/2026-07-20-admin-panel-remediation/`.

## Context

The admin-api security module was built dashboard-first against admin-schema
telemetry tables (`login_attempts`, `api_usage_logs`, `user_sessions`,
`security_events`) on the assumption a producer existed. None does:

- `recordLoginAttempt` / `logApiUsage` / `createSession` (the sole writers of
  those tables) have **zero callers**.
- The only ingestion endpoints (`POST /security/monitoring/events`,
  `POST /security/monitoring/analyze/login`) sit behind the global SUPER_ADMIN
  guard, so service-to-service ingestion is structurally impossible.
- `auth-service` treats `auth.audit_logs` as its source of truth and fans out
  only a consumer-less `UserLoggedIn` success event; there is no
  `LoginAttempted`/`LoginFailed` event contract in `libs/event-contracts`.
- `updateThreatFeeds` was a stub logging "Would update threat feed".

Consequently every anomaly detector (brute-force, credential-stuffing, geo,
time) counts over permanently-empty tables; `security_events`, `incidents`, and
threat indicators stay empty; and `getHealthScore` computes ~94 → the FE mapped
`>= 85` to "healthy" → a permanent green gauge regardless of real attacks. This
is the systemic "table-with-readers-but-no-writer" class.

## Decision

### Part A — never render fabricated assurance (implemented)

`SecurityMonitoringService.getTelemetryLiveness()` returns
`{ dataStatus: 'live' | 'stale' | 'no_data', lastSeenAt }`, computed from the
newest row across the four telemetry sources (window: 24h). The health-score
endpoint returns it as a **required** field; the FE `BackendSecurityHealthScore`
type + `HealthGauge` render an explicit "No telemetry" state (grey, empty ring)
whenever `dataStatus !== 'live'`, so a score computed over empty tables can
never be presented as "healthy". The fabricated threat-feed machinery
(`initializeFeeds` + the `updateThreatFeeds` cron) is deleted; the real
`cleanupThreatIntelligence` cron is retained.

### Part B — revive the supply chain via the event backbone (tracked)

Make ingestion automatic through the platform's existing NATS/event-bus, and
make "no telemetry" the honest state until it flows:

1. **Contract at the source** (`libs/event-contracts`): add a flat
   `LoginAttempted` event (ADR-006 flat shape, `createBaseEvent`, PascalCase)
   with `{ emailMasked, ipAddress, success, failureReason?, userId?, tenantId?,
   geo? }`, a JSON Schema validator (trust-boundary crossing), and an index
   export.
2. **Producer** (`auth-service`): publish `LoginAttempted` on **both** success
   and failure paths via the existing `BestEffortEventPublisher`
   (`auth.audit_logs` stays SoT; add `LoginAttempted` to its allowlist).
3. **NATS SSoT** (ADR-015): add publish (auth) + subscribe (admin-api)
   permissions for `events.*.LoginAttempted` in
   `infrastructure/nats/services.yaml` and regenerate `nats.conf` via
   `scripts/nats/generate-nats-conf.py` in the **same** commit. (Note the prior
   prod permission-violation precedent on `UserLoggedIn`.)
4. **Consumer** (`admin-api`): a new `login-attempt.handler.ts` subscribing via
   `@platform/event-bus`, validating against the JSON schema, then
   `recordLoginAttempt(...)` + `analyzeLoginAttempt(...)` — this single consumer
   revives brute-force / credential-stuffing / geo / time detection, event
   creation, and incident auto-escalation (they all read
   `admin.login_attempts`). Remove the now-redundant SUPER_ADMIN-only
   `POST analyze/login` ingestion path.
5. **API-abuse / session-hijacking detectors**: `checkApiAbuse` and
   `checkSessionHijacking` have no producers. Either wire `gateway-api`'s
   throttler-rejection path to publish `ApiRateLimitExceeded` (consumed by the
   same handler layer), or delete the two dead detectors — never leave uncalled
   detectors implying coverage.
6. **External threat feeds**: real feed integration replaces the deleted stub;
   until then, threat indicators are driven only by internal detection
   (`addThreatIndicator`). External-feed integration is its own tracked item.

### Verification gate (precondition for Part B merge)

Because Part B changes NATS permissions and cross-service event flow, it MUST
land with a Docker-backed integration test:
`security-telemetry-pipeline.integration.spec.ts` publishing synthetic
`LoginAttempted` events through the event-bus harness and asserting a
`login_attempts` row, a threshold-crossing `security_event`, and incident
escalation; plus an extension to `e2e/tests/integration/nats-invariants.spec.ts`
asserting every subject the admin-api security module subscribes to has a
granted publisher in `services.yaml`.

## Consequences

- **Positive (Part A):** the primary SUPER_ADMIN security surface is honest —
  "No telemetry" instead of a fabricated green. The false-assurance class has a
  liveness contract the FE type enforces at compile time. Threat-feed theater is
  gone.
- **Residual risk (until Part B):** security anomaly detection is **not
  functional** — the pane truthfully shows no telemetry, and brute-force
  detection relies on the platform-level compensating controls (auth-service
  account lockout, Prometheus `auth_login_attempts_total` SLO alerts). This
  residual is the tracked finding ADMIN-CRITICAL-016.

## References

- Finding: `docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/security.md#APA-240`
- Health-score honesty: `apps/admin-api-service/src/security/services/security-monitoring.service.ts` (`getTelemetryLiveness`), `apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts`
- FE gauge: `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx`, `web/modules/admin-panel/src/services/types/security.ts`
- NATS SSoT: ADR-015, `infrastructure/nats/services.yaml`
- Event backbone: ADR-006 (flat events), `@platform/event-bus`, `libs/event-contracts`
