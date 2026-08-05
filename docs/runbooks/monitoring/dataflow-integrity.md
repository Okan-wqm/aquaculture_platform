# Data-Flow Integrity Alerts — Runbook

Alerts from `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`
(Watchdog W-A). Each routes to a Lane-B auditor via its `target_auditor` label;
sustained CRITICALs are filed to the finding registry and ingested into ARIA
with `aria-kernel runtime signal ingest`.

## OutboxPendingAgeSloBreached (critical)

The oldest unpublished outbox event on `{{app}}` exceeds the 10-minute stall
SLO (`OUTBOX_PENDING_AGE_ALARM_MS`, `platform/libs/outbox/src/constants.ts:60`).
The relay is stalled or dead.

1. `SELECT count(*), max(now()-"createdAt") FROM <schema>.<svc>_outbox WHERE "publishedAt" IS NULL AND "isDeadLettered"=false;`
2. Inspect `lastError` on the oldest rows; check the service's NATS connection (`docker logs`, boot signal `nats_auth_mode_mtls`).
3. If the relay restarted and drained, resolve; otherwise file with `owner_agent: job-queue-auditor`.

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

## Signal hygiene

When a condition clears, close the ARIA side:
`aria-kernel runtime signal resolve --signal-id <id> --resolution-note "<what fixed it>"`.
