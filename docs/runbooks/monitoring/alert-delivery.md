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
# optional; defaults to ALERT_PAGE_EMAIL_TO
export ALERT_DIGEST_EMAIL_TO='<where batched warnings go>'

./scripts/monitoring/render-configs.sh
docker compose -f docker-compose.droplet.yml up -d --no-deps alertmanager
```

The SMTP values are the same four `notification-service` already uses; read them
from the droplet environment rather than inventing a second mail identity.

The script refuses to run if any delivery setting is missing, and refuses to
finish if a placeholder survived — a half-rendered config (real SMTP, placeholder
recipient) is worse than one that never started.

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

## Who gets what

| severity      | route     | receiver | today                                               |
| ------------- | --------- | -------- | --------------------------------------------------- |
| `critical`    | page      | email    | super-admin mailbox, 10s group wait, repeats hourly |
| `warning`     | digest    | email    | same mailbox, batched, repeats every 12h            |
| `none`        | heartbeat | webhook  | **unwired — see below**                             |
| anything else | `null`    | —        | dropped (and CI fails a rule that uses one)         |

`page` and `digest` take separate recipient variables even though both default
to the same mailbox. Splitting alerts by role later is one export per route, not
a redesign.

## The deadman is still unwired

The `none` severity is a deadman: `50-monitoring-self.yml` fires it constantly on
purpose, and an EXTERNAL watcher is supposed to alarm when the pings stop. Email
cannot play that role — a mailbox receiving nothing looks exactly like a mailbox
nobody sent to.

So `heartbeat` stays a webhook and stays unwired until an endpoint exists, and
`render-configs.sh` says so on every run rather than leaving a loopback URL that
reads like configuration. Until then: **if the monitoring stack dies, nothing
will announce it.** Wiring it means an external dead-man service (Healthchecks.io,
Cronitor, or an endpoint on infrastructure that does not share this droplet's
fate) and exporting `ALERTMANAGER_HEARTBEAT_URL`.

## Related

- `docs/runbooks/monitoring/dataflow-integrity.md` — what the delivery alerts mean
- `docs/runbooks/monitoring/tenant-provisioning.md` — provisioning alerts
- `tests/invariants/monitoring-alert-delivery.spec.ts` — fails CI on a severity
  with no route, a routed receiver with no delivery integration, or a real
  address committed to the repo
