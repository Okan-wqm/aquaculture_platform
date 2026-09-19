# JetStream file store versus the streams the event bus declares

**Date:** 2026-09-19 · **Reviewer:** claude (live diagnosis on the production droplet while
landing PR #1582) · **Scope:** `infrastructure/docker/nats/nats.conf`,
`scripts/deploy/droplet-capacity.sh`,
`infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`,
`platform/libs/event-bus/src/nats/nats-event-bus.ts`

**Trigger.** Three operator deploys on 2026-09-19 (12:26Z, 17:32Z, 18:29Z) ended at status
`db_complete` in `platform.release_ledger`; two the day before ended `rollback_failed` at
`service_recreate`. The deploy job log shows the last step reached: NATS recreated for the ACL
reload, then `NATS did not become healthy after ACL reload`. The container's own log says why:

```text
Starting restore for stream '$G > AQUACULTURE_TELEMETRY'
Error recreating stream "AQUACULTURE_TELEMETRY": insufficient storage resources available (10047)
Healthcheck failed: "JetStream stream '$G > AQUACULTURE_TELEMETRY' could not be recovered"
```

`aqua-nats` has been `unhealthy` since 18:32Z. The stream's on-disk `meta.inf` carries
`max_bytes: 6442450944` (6GiB); `nats.conf` carries `max_file_store: 2GB`.

**Findings:** INFRA-HIGH-177 (fixed here).

## INFRA-HIGH-177 — the broker's file store cannot hold the streams the event bus declares

**Defect.** Commit `bd5032dfd` (2026-08-25) taught the event bus to create `AQUACULTURE_TELEMETRY`
with a 6GiB `max_bytes` (the designed 60-minute outage buffer at the 2K msg/s envelope). Its own
docblock, the alert rule's comment and the capacity gate's comment all say `max_file_store` must be
raised in the same commit. None of the three was. The running broker had already accepted the
stream, so the mismatch was invisible until a deploy recreated the container: NATS refuses to
recreate a stream whose budget exceeds the store, the health check never passes, and the deploy
aborts before any service is restarted. Every deploy since has died there.

**Why the gate that existed did not fire.** `droplet-capacity.sh` guards
`max_file_store ≥ NATS_REQUIRED_FILE_STORE_BYTES`, "the half-done version of exactly that change".
Its floor was a hand-typed copy of the stream sizes (1920MiB, the events stream alone) and drifted
with them. A gate whose expected value is a second copy of the thing it checks cannot catch the
copy going stale.

**Fix.** PR #1621 (INFRA-HIGH-176, merged 22:34Z the same evening) raised `max_file_store` to
10GB and pinned "sum of reservations < store" in
`tests/invariants/nats-jetstream-store-budget.spec.ts`.
This finding is the rest of the drift: the capacity floor becomes the exact reserve (7.75GiB × 1.25
= 10401873920 bytes), the alert threshold becomes 75% of the store (8053063680 bytes), the two
runbooks and the event-bus comments stop naming 2GB, and the merged invariant gains three more
cases held to the event-bus source: every single stream fits the store on its own (a restart
recreates them one at a time), the gate's floor equals the reserve exactly, the alert equals 75% of
the store exactly. Falsified: with the old floor and threshold in place the new cases fail.

**Live recovery.** The droplet's deploy checkout is materialised at the deployed SHA, so this lands
on the broker through the next deploy (which recreates NATS with the new limit) — or, before that,
by applying the same one-line change to the checkout's `nats.conf` and restarting `aqua-nats`. The
JetStream data on disk is intact (events 8,356 messages restored; the telemetry stream directory is
24KB).

**Also observed, not fixed here.** `sensor-service` (`fazai-2`) and `auth-service`
(`local-fence-msfix`) — feature-branch builds running in production — publish through inbox
prefixes the main-generated ACL does not grant (`_INBOX.>` and `_INBOXAQUACULTURE_AUTH_SERVICE.>`
against grants of `_INBOXSENSOR_SERVICE.>` / `_INBOXAUTH_SERVICE.>`). The sensor bus logs
`Failed to publish event SensorReading … Permissions Violation` every 10 seconds and has all day;
this predates the deploys above and is the mixed-version state itself, which a full deploy from
main ends.

**Owner:** claude. **Status:** RESOLVED by this PR (config side); live broker pending the deploy.
