# Messaging Enterprise Release Runbook

## Preflight

- Verify release diff is limited to messaging, auth/farm request handlers,
  gateway websocket, notification push, event contracts, NATS config,
  aquamobil messaging UI, docs, and CI gates.
- Confirm `messaging.messaging_outbox` exists and tenant schemas do not contain
  active `messaging_outbox` rows.
- Confirm tenant isolation constraints are validated:
  `SELECT conname FROM pg_constraint WHERE conname LIKE 'fk_%tenant%' AND NOT convalidated;`
- Confirm outbox backlog and dead letters are empty or explicitly accepted.
- Regenerate NATS config from `infrastructure/nats/services.yaml` and run ACL
  smoke with the `messaging_service` and `notification_service` identities.

## Deploy Order

1. Docs/contracts and generated NATS ACL config.
2. Tolerant consumers: gateway, notification, frontend.
3. Auth/farm request responders.
4. Messaging publisher, outbox, AI/privacy, and DB hardening.
5. Canary tenant, then full rollout.
6. Legacy cleanup after canary is stable.

## Canary Abort

Abort or roll back the app image if any condition holds for one canary window:

- Outbox oldest pending age exceeds 5 minutes.
- Publish failures or dead letters increase.
- Subject mismatch drops are non-zero.
- Gateway websocket invalidation failures are non-zero.
- Messaging/gateway readiness flaps.
- p99 send-message latency regresses beyond the agreed release SLO.

## Rollback

Do not run destructive DB `down()` migrations for tenant hardening. Roll back
the app image, keep constraints/data forward, and apply a forward remediation
migration if the schema contract needs repair.
