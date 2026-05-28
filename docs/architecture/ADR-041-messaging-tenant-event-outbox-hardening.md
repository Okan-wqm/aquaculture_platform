# ADR-041: Messaging Tenant, Event, and Outbox Hardening

Status: Accepted

## Context

Messaging uses schema-per-tenant data, JetStream events, a transactional
outbox, WebSocket invalidation, push fanout, and optional AI egress. The
tenant boundary must be enforced by the command/database/event architecture,
not by resolver checks or payload conventions.

## Decision

- Tenant-scoped events use exactly `events.{tenantId}.{eventType}`.
- Wildcard consumers must receive broker subject context through the shared
  event bus; payload-only tenant validation is not sufficient.
- `messaging.messaging_outbox` is the only messaging outbox table. Tenant
  schemas must not own outbox tables or triggers.
- Messaging commands own authorization in the same tenant transaction that
  mutates data.
- Principal/admission services are required dependencies. Missing auth
  validation is a startup/test failure, not a runtime fallback.
- AI egress is gated centrally. Consent denial or uncertainty blocks semantic
  search, AI chat, custom AI endpoints, sentiment, embeddings, and actions.
- Push provider payloads carry only opaque notification references and generic
  text.

## Consequences

- Release validation must include real NATS ACL smoke, source-only outbox
  checks, validated tenant FKs, and readiness/metrics checks.
- DB rollback for this hardening is forward-only; use app-image rollback and
  forward remediation rather than destructive `down()` migrations.
