# Life-safety alerting end to end — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `alert-engine-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | apps/alert-engine, apps/notification-service, farm-signal alert services, escalation |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The reviewer traced a dissolved-oxygen crash from sensor reading to a person's phone. The chain
breaks at notification delivery (no channel delivers in production), at incident creation for farm
signals, and at escalation. Nothing raises an alarm when a sensor goes silent.

## Ranked blockers

- **B1. No channel delivers in production.**
  - `docker-compose.droplet.yml:1515-1541` passes no `SMS_*`, `TWILIO_*`, `PUSH_*` or `FIREBASE_*`
    variables, and there is no `env_file`.
  - With SMS and push disabled, `sms.service.ts:167-170` and `push.service.ts:260-262` return
    `mock-*` ids, which are logged as SENT.
  - `firebase-admin` is in no package.json, so FCM cannot work even if configured.
  - Email works only if `SMTP_HOST` is set; it defaults to empty (`:1537`).
  - Health stays green: `health.controller.ts:31-43` skips disabled providers and never checks
    SMTP.
- **B2. ALERT-CRITICAL-009 confirmed.**
  - `Baseline.ts:22,43` makes `rule_id` a uuid FK, but the farm-signal services pass `system:*`
    strings (`farm-signal-incident.service.ts:171,190`).
  - Farm signals also emit no AlertTriggered. Each retry inserts another AlertHistory row
    (`water-quality-critical-alert.service.ts:144`).
- **B3. ALERT-CRITICAL-004 confirmed.**
  - No default escalation policy: `escalation-policy.service.ts:226` returns null and
    `escalation-manager.service.ts:275` stops.
  - Nothing consumes AlertEscalated. No DO/pH rules are seeded for a tenant.
  - A rule with no recipients is acked silently (`alert-triggered.handler.ts:151-154`).
- **B4. No dead-man for stale sensors.**
  - Nothing alerts when readings stop.
  - The MQTT last-will handler (`mqtt-listener.service.ts:722-735`) only flips a DB flag.
  - `EdgeDeviceAlarm` is consumed only by the gateway websocket.

## Major

- **M5. The rate limit drops real alerts.**
  - The limit is 100/min per tenant (`notification-dispatcher.service.ts:136,289-294`), shared
    with command notifications (`:404`).
  - When exceeded it throws a 400, which becomes a terminal dead-letter
    (`handler-outcome.ts:189-191`). A Redis outage in production does the same (`:653-658`).
  - There is no life-safety bypass, so a power cut that crashes DO across many ponds overflows it.
- **M6. Cooldown suppresses real alerts.**
  - The cooldown key is claimed before the DB transaction and not released on failure
    (`alert-evaluation.service.ts:294-301,366-378`).
  - The handler acks transient SensorReading failures (`sensor-reading.handler.ts:147-149`), so a
    DB blip hides the alert for the whole cooldown.
  - Cooldown and incident dedup are keyed per (tenant, rule), not per pond (`:295`, `:418-425`):
    pond B's crash during pond A's cooldown is dropped.
- **M7. Escalation timers do not survive a restart.**
  - Timers are in-process `setTimeout` (`escalation-manager.service.ts:116,810`).
  - Restore and the sweeper (`:157-239`) run with no tenant context, so they query the `alert`
    schema (`tenant-connection-bootstrap.service.ts:103,149`); the incident is not found and is
    skipped.
  - Escalation state sits in Redis configured `allkeys-lru` with no TTL
    (`docker-compose.droplet.yml:530-531`), so it can be evicted.
- **M8. Incidents cannot be acknowledged or resolved.**
  - Ack/resolve only touch AlertHistory (`alert-rule.service.ts:262,287`). WARNING-and-above never
    auto-resolves (`:575-578`). The first open incident absorbs every later one for good
    (ALERT-HIGH-005, broader than filed: it also covers sensor-rule incidents).

## Minor

- Send failures are swallowed and the event is acked; retries stop after 3
  (`notification-dispatcher.service.ts:818-821`, `:1005`).
- One untyped recipient list is applied to every channel.
- Suppression windows silence critical incidents too (`:281`).

## Registry

| ID | Status | Note |
| --- | ------ | ---- |
| ALERT-CRITICAL-009 | CONFIRMED | Blocker B2 |
| ALERT-CRITICAL-004 | CONFIRMED | Blocker B3 |
| First pass (c): SMS SNS / push TODO | CONFIRMED, corrected | SNS (`sms.service.ts:333`) and OneSignal/APNS (`push.service.ts:413`, `:427`) are TODO; Firebase code exists but its package is missing and it is not configured |
| ALERT-HIGH-005 | CONFIRMED | Broader than filed |
| ALERT-MEDIUM-006 | CONFIRMED | `mortality-alert.service.ts:55` |
| ALERT-MEDIUM-007 | CONFIRMED | `water-quality-events.ts:28-32`, no siteId |
| ALERT-MEDIUM-008 | CONFIRMED | `alert.module.ts:66-96` |
| ALERT-MEDIUM-003 | CONFIRMED | `create-alert-rule.dto.ts:24-27` |
| SEC-MEDIUM-111 | CONFIRMED | DTO `:86-89` |
| ALERT-CRITICAL-001 (RESOLVED) | Consistent with code | The outbox is in place |
| ALERT-HIGH-002 (RESOLVED) | Consistent | But it causes M6 |
| FARM-MEDIUM-333 | Not verified | Farm domain |

## Orchestrator verification

- Verified in the working tree: the notification-service environment block in compose carries only
  `SMTP_*` (default empty) and no SMS/Twilio/push/Firebase variables; the `mock-sms-` and
  `mock-push-` return values; `firebase-admin` appears in no package.json.

## Not verified

- The actual droplet `.env` values, especially `SMTP_HOST`; the live DB contents (rules and
  policies); whether production is the droplet or k8s (the k8s template's `SENDGRID_API_KEY` is
  read by no code); telemetry stream retention; how `acknowledgment-tracker.service.ts` works.

## Registry entries

This review appended 7 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| ALERT-CRITICAL-019 | CRITICAL | Notification-service has no delivering channel in production: the droplet compose passes no SMS\_\*, TWILIO\_\*, PUSH\_\* or FIREBASE\_\* variables, disabled SMS and push return mock-\* ids that are logged as SENT, firebase-admin is in no package.json, email works only if SMTP\_HOST (default empty) is set, and health stays green because disabled providers are skipped |
| ALERT-CRITICAL-020 | CRITICAL | Nothing alerts when a sensor goes silent: there is no stale-reading dead-man, the MQTT last-will handler only flips a database flag, and EdgeDeviceAlarm is consumed only by the gateway websocket, so a dead probe during an oxygen crash produces no alarm |
| ALERT-HIGH-021 | HIGH | The notification dispatcher rate-limits at 100/min per tenant shared with command notifications, throws a 400 that becomes a terminal dead-letter when exceeded (and on a Redis outage in production), and has no life-safety bypass, so a power cut that crashes DO across many ponds overflows it |
| ALERT-HIGH-022 | HIGH | Alert cooldown suppresses real alerts: the cooldown key is claimed before the DB transaction and not released on failure, the handler acks transient SensorReading failures so a DB blip hides the alert for the whole cooldown, and cooldown and incident dedup are keyed per tenant and rule rather than per pond |
| ALERT-HIGH-023 | HIGH | Escalation timers do not survive a restart: they are in-process setTimeout, restore and the sweeper run without tenant context and so query the alert schema and skip the incident, and escalation state sits in Redis configured allkeys-lru with no TTL so it can be evicted |
| ALERT-MEDIUM-024 | MEDIUM | Notification send failures are swallowed and the event acked with retries stopping after 3, so a transient provider outage drops the alert permanently |
| ALERT-MEDIUM-025 | MEDIUM | Suppression windows also silence critical incidents, and one untyped recipient list is applied to every channel (email addresses and phone numbers alike) |
