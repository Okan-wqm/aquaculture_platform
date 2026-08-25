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
