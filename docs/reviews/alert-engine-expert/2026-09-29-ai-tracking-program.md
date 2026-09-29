# Farm-signal alarm delivery — alert-engine-expert, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks,
tracking agents, AI configuration). Four reviewers (alert-engine, AI safety, farm domain,
architecture) attacked plan rev 2 against origin/main `dae95efb3`; the main session re-verified the
load-bearing claims in code, and ALERT-CRITICAL-004 on the live database. MT-HIGH-064 and
MT-MEDIUM-065 come from the PR-T1 audit. Each finding names the plan PR that closes it; "owner
decision" entries need a product decision before any code.

## ALERT-CRITICAL-004

Farm-signal incidents (critical water quality, mortality, low stock, feed stockout) reach nobody: no
default escalation policy exists and nothing consumes AlertEscalated.

- **Severity:** CRITICAL. **Deadline:** 2026-10-15. **Closes in:** plan PR-S1.
- **Evidence:** `apps/alert-engine/src/escalation/escalation-manager.service.ts:275` — no matching
  policy returns null; live DB had 0 escalation_policies.
- **Rule:** Life-safety alarm delivery.

Verified on the live DB 2026-09-29 (0 policies, 0 incidents). notification-service consumes only
AlertTriggered. Closed by plan PR-S1.

## ALERT-HIGH-005

Farm-signal incidents can never be acknowledged or resolved, and the first open incident per key
absorbs every later occurrence without re-escalation.

- **Severity:** HIGH. **Deadline:** 2026-10-31. **Closes in:** plan PR-S2.
- **Evidence:** `apps/alert-engine/src/alert/services/farm-signal-incident.service.ts:110` — dedup
  onto open incidents; no ack/resolve path.
- **Rule:** Incident lifecycle.

Closed by plan PR-S2 (ack/resolve API + level-triggered clear events).

## ALERT-MEDIUM-006

No shared signal key across incident ruleId, task subject key and AI findings; mortality incidents
are keyed tenant-wide so one batch's deaths bump another batch's incident.

- **Severity:** MEDIUM. **Deadline:** 2026-10-15. **Closes in:** plan PR-S1.
- **Evidence:** `apps/alert-engine/src/alert/services/mortality-alert.service.ts:54` — tenant-wide
  mortality key.
- **Rule:** SSoT for signal identity.

Closed by plan PR-S1 (signalKey builder in event-contracts, per-batch mortality key).

## FARM-MEDIUM-333

WaterQualityCritical is emitted on every measurement with no hysteresis, so readings that flap
across a limit produce event storms.

- **Severity:** MEDIUM. **Deadline:** 2026-10-31. **Closes in:** plan PR-S2.
- **Evidence:** `apps/farm-service/src/water-quality/water-quality.service.ts:397` — emit per
  measurement.
- **Rule:** Edge-triggered alarm events.

Closed by plan PR-S2.

## ALERT-MEDIUM-007

Farm alarm events carry no siteId (and water-quality events no actor), so recipients cannot be
resolved per site.

- **Severity:** MEDIUM. **Deadline:** 2026-10-15. **Closes in:** plan PR-S1.
- **Evidence:** `libs/event-contracts/src/water-quality-events.ts:28` — WaterQualityCritical has no
  siteId.
- **Rule:** Event contract completeness.

Closed by plan PR-S1.

## ALERT-MEDIUM-008

alert-engine ChannelRouter and NotificationDispatcher are registered in no module (dead code) and
notification-service has no per-user notification preferences.

- **Severity:** MEDIUM. **Deadline:** 2026-11-15. **Closes in:** plan PR-S3.
- **Evidence:** `apps/alert-engine/src/alert/alert.module.ts:66` — router/dispatcher absent from
  providers.
- **Rule:** Dead code; notification preference SSoT.

Closed by plan PR-S3.
