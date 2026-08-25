<!-- markdownlint-disable MD013 -->

# Runbook: making alerts arrive

## What was wrong

Alertmanager has been running on the droplet for weeks with its three receivers
pointed at `http://127.0.0.1:9099/{page,digest,heartbeat}`. Nothing has ever
served that port. Every alert this platform raised — including
`TenantIsolationViolationDetected`, which fires on a potential cross-tenant read
— was delivered to nobody.

The reason was not neglect. The original design routed to external paging
endpoints, and `render-configs.sh` hard-failed when their URLs were unset. They
were never procured, so the script could not run, so no deploy path called it,
so the placeholders stayed. A dependency that cannot be satisfied is the same as
a step nobody performs.

Email is the delivery that exists: the droplet already runs working SMTP
credentials for `notification-service`.

## Activating delivery

On the droplet, from the deployment checkout:

```bash
export SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... SMTP_FROM=...
export ALERT_PAGE_EMAIL_TO='<super-admin mailbox>'
export ALERT_DIGEST_EMAIL_TO='<where batched warnings go>'
export ALERTMANAGER_HEARTBEAT_URL='https://<external-deadman-service>/<opaque-key>'
export OBSERVABILITY_INTERNAL_API_KEY='<observability-service internal API key>'
export MQTT_EXPORTER_PASSWORD='<mqtt_exporter password>'

MONITORING_PROFILE=monitoring ./scripts/monitoring/monitoring-up.sh
```

The SMTP values are the same four `notification-service` already uses; read them
from the droplet environment rather than inventing a second mail identity.

The dedicated `docker-compose.monitoring.yml` project is the only owner of the
monitoring containers. The activation script refuses to run if delivery,
heartbeat, or guarded scrape credentials are missing, and refuses to finish if
a placeholder survived.

## Verifying it arrives

```bash
# Fire a synthetic alert straight at Alertmanager.
docker exec aqua-alertmanager amtool alert add \
  alertname=DeliveryProbe severity=critical \
  --annotation=summary='delivery probe, ignore' \
  --alertmanager.url=http://localhost:9093
```

An email should reach `ALERT_PAGE_EMAIL_TO` within the route's `group_wait`
(10s for critical). If it does not:

```bash
docker logs aqua-alertmanager --since 5m | grep -i 'notify\|smtp\|error'
```

Gmail-style providers reject envelope senders they do not own — `SMTP_FROM` must
be the authenticated mailbox, not a made-up address.

Record the received message ID, Alertmanager firing timestamp, recipient and
UTC receipt timestamp in the Task 0 evidence bundle. A successful `amtool`
submission without a received-message record is not delivery evidence.

## Verifying the deadman failure path

First confirm that the external deadman shows a fresh heartbeat from the
`Watchdog` alert. Then stop only Alertmanager long enough to cross the external
service's configured grace period:

```bash
docker stop aqua-alertmanager
# wait for and record the external deadman notification
docker start aqua-alertmanager
```

Record the last successful heartbeat, interruption start, external notification
ID and timestamp, and the first heartbeat after recovery. Restore Alertmanager
immediately after receipt. A continuously green heartbeat is not proof of the
failure path; the external service must detect the intentional cut.

## Who gets what

| severity      | route     | receiver | today                                               |
| ------------- | --------- | -------- | --------------------------------------------------- |
| `critical`    | page      | email    | super-admin mailbox, 10s group wait, repeats hourly |
| `warning`     | digest    | email    | same mailbox, batched, repeats every 12h            |
| `none`        | heartbeat | webhook  | required external deadman endpoint                  |
| anything else | `null`    | —        | dropped (and CI fails a rule that uses one)         |

`page` and `digest` take separate recipient variables even though both default
to the same mailbox. Splitting alerts by role later is one export per route, not
a redesign.

## Deadman boundary

The `none` severity is a deadman: `50-monitoring-self.yml` fires it constantly on
purpose, and an EXTERNAL watcher is supposed to alarm when the pings stop. Email
cannot play that role — a mailbox receiving nothing looks exactly like a mailbox
nobody sent to.

The heartbeat stays a required webhook to infrastructure that does not share
the droplet's fate. `render-configs.sh` rejects activation without
`ALERTMANAGER_HEARTBEAT_URL`; the committed loopback address is an inert
placeholder, not a deployable configuration.

## Related

- `docs/runbooks/monitoring/dataflow-integrity.md` — what the delivery alerts mean
- `docs/runbooks/monitoring/tenant-provisioning.md` — provisioning alerts
- `tests/invariants/monitoring-alert-delivery.spec.ts` — fails CI on a severity
  with no route, a routed receiver with no delivery integration, or a real
  address committed to the repo
