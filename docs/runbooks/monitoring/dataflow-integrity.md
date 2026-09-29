# Data-Flow Integrity Alerts — Runbook

Alerts from `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`
(Watchdog W-A). Each routes to a Lane-B auditor via its `target_auditor` label;
sustained CRITICALs are filed to the finding registry and ingested into ARIA
with `aria-kernel runtime signal ingest`.

## OutboxPendingAgeSloBreached (critical)

The oldest unpublished outbox event on `{{app}}` exceeds the 10-minute stall
SLO (`OUTBOX_PENDING_AGE_ALARM_MS`, `platform/libs/outbox/src/constants.ts:60`).
The relay is stalled or dead.

1. `SELECT count(*), max(now()-"createdAt") FROM <schema>.<svc>_outbox`
   `WHERE "publishedAt" IS NULL AND "isDeadLettered"=false;`
2. Inspect `lastError` on the oldest rows; check the service's NATS
   connection (`docker logs`, boot signal `nats_auth_mode_mtls`).
3. If the relay restarted and drained, resolve; otherwise file with
   `owner_agent: job-queue-auditor`.

## OutboxDeadLetterGrowing (high)

Publish failures accumulating on `{{app}}` — rows are en route to dead-letter.
Same triage as above; additionally check `retryCount` distribution vs `OUTBOX_MAX_RETRIES=5`.

## MessagingDlqGrowing (high)

`messaging_dlq_growth_total` increased. Inspect
`messaging.messaging_outbox` rows with `isDeadLettered=true`; correlate with
`messaging_subject_payload_mismatch_total`.

## NotificationChannelFailing (high)

5xx burst on notification-service. Group `notification.notification_logs` by
`(channel, status)` for the failing window; check provider credentials and the
retry scheduler (`retry-scheduler.service.ts`, every 5 min).

## LifeSafetyAlarmDegraded (critical)

A farm alarm (critical water quality, mortality, stock-out) did not take its
normal path to a person. `reason` says which floor caught it:

- `no_policy_match` (alert-engine): the tenant's active escalation policies do
  not cover the severity. Tenant admins were paged by the hard floor. The
  policy writer refuses such a policy set, so look for a direct database edit:
  `SELECT id, name, severity, is_active, rule_ids, farm_ids FROM
tenant_<uuid>.escalation_policies;`
- `widened_to_tenant_admins` (notification-service): the policy's role/site/user
  targets resolved to nobody (no active holder, nobody assigned to the site).
  Tenant admins were paged instead. Fix the policy targets or the site
  assignments.
- `no_recipients` (notification-service): not even a tenant admin is active.
  The alarm is on the dead-letter stream — nobody was paged. Page the tenant
  by other means, then restore an active admin.

## LifeSafetyAlarmDeadLettered (critical)

A life-safety event exhausted its hour-long redelivery budget
(`LIFE_SAFETY_REDELIVERY`, `platform/libs/event-bus/src/interfaces/redelivery-policy.ts`)
or was terminated by its handler. Read the envelope on the `AQUACULTURE_DLQ`
stream (subject carries the tenant and event type) and the service log line
`dead-lettered (retry exhausted|terminated)`; fix the dependency that was down
(auth-service, the database, Redis) and replay the envelope.

## Signal hygiene

When a condition clears, close the ARIA side:
`aria-kernel runtime signal resolve --signal-id <id> --resolution-note "<what fixed it>"`.
