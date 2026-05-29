# Messaging Enterprise Release Runbook

## Preflight

- Verify release diff is limited to messaging, auth/farm request handlers,
  gateway websocket, notification push, event contracts, NATS config,
  aquamobil messaging UI, docs, and CI gates.
- Verify the release workflow `.github/workflows/messaging-enterprise-release.yml`
  is green for the staged SHA.
- Confirm `messaging.messaging_outbox` exists and tenant schemas do not contain
  active `messaging_outbox` rows.
- Confirm tenant isolation constraints are validated:
  `SELECT conname FROM pg_constraint WHERE conname LIKE 'fk_%tenant%' AND NOT convalidated;`
- Confirm outbox backlog and dead letters are empty or explicitly accepted.
- Regenerate NATS config from `infrastructure/nats/services.yaml` and run ACL
  smoke with the `gateway_service`, `messaging_service`, and
  `notification_service` identities.
- Capture staging evidence in `artifacts/messaging-enterprise-release/evidence.md`.
  A bypass is valid only with `artifacts/messaging-enterprise-release/bypass-approval.md`
  containing explicit exec and security approval.

## Deploy Order

1. Docs/contracts and generated NATS ACL config.
2. Tolerant consumers: gateway, notification, frontend.
3. Auth/farm request responders.
4. Messaging publisher, outbox, AI/privacy, and DB hardening.
5. Canary tenant or staged SHA smoke substitute, then full rollout.
6. Legacy cleanup after canary is stable.

## Canary Abort

Abort or roll back the app image if any condition holds for one canary window:

- Outbox oldest pending age exceeds 5 minutes.
- Any DLQ growth.
- Subject mismatch drops are greater than 0.
- Gateway websocket invalidation failures are greater than 0.
- Messaging/gateway readiness flaps exceed 1 per 10 minutes.
- p99 send-message latency regresses beyond the agreed release SLO.

## Staging Smoke Evidence

Capture, at minimum:

- Two-tenant send/edit/delete/read smoke across two gateway pods and Redis fanout.
- Push click through `notificationRef` resolution; no channel/message IDs in push payload.
- Real NATS mTLS ACL smoke output, including denied broad/cross-service subjects.
- DB validation query output proving source-only outbox and validated tenant FKs.
- AI egress denial test proving zero payload bytes leave when consent is denied.
- Dashboard/query screenshots or exports for outbox age, DLQ growth, subject mismatch,
  websocket invalidation failures, readiness flaps, and p99 send latency.
- Rollback manifest naming the app images that can be rolled back without schema
  rollback and the DB snapshot/forward-remediation path if schema rollback is needed.
- Owner signoff.

## Rollback

Do not run destructive DB `down()` migrations for tenant hardening. Roll back
the app image, keep constraints/data forward, and apply a forward remediation
migration if the schema contract needs repair.
