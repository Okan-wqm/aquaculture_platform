<!-- ARIA-HISTORICAL: Plan 032 Faz 032f runbook. Authority for the gateway's code paths is aria-kernel/aria_kernel/gateway/. -->

# ARIA event gateway — operator runbook

The gateway is the droplet daemon that turns GitHub webhooks, Alertmanager
notifications and operator commands into rows on `gateway/inbox.jsonl`, routes
them deterministically (issue labelled `aria` → mission; PR events →
`pr-events.jsonl`; failed CI / firing alerts → runtime signals; operator
command → `control/commands.jsonl`) and runs a closed-vocabulary schedule
table (`cycle | drain | daily_report | doctor | telemetry_export | deliver |
inbox_drain`). There is no action that hands text to a model.

## Install (droplet)

```bash
sudo install -m 0644 infrastructure/aria/aria-gateway.service /etc/systemd/system/
sudo install -d -m 0750 -o gharunner /etc/aria
sudo -u gharunner sh -c 'umask 077; cat > /etc/aria/aria.env' <<'ENV'
ARIA_GITHUB_WEBHOOK_SECRET=<random 32+ bytes>
ARIA_ALERTMANAGER_BEARER=<random 32+ bytes>
ARIA_OPERATOR_BEARER=<random 32+ bytes>
ARIA_GATEWAY_ACTOR_ALLOWLIST=<github-login>[,<github-login>]
GH_TOKEN=<fine-grained token: actions:write on this repo only>
ENV
sudo systemctl daemon-reload && sudo systemctl enable --now aria-gateway.service
sudo nginx -t && sudo systemctl reload nginx     # infrastructure/nginx/droplet.conf carries /aria/webhook/
```

`scripts/aria/provision_runner.sh --dry-run` reports the unit + env-name drift.

## GitHub webhook

Repository → Settings → Webhooks → Add: payload URL
`https://app.suderra.com/aria/webhook/github`, content type `application/json`,
secret = `ARIA_GITHUB_WEBHOOK_SECRET`, events: **Issues, Issue comments, Pull
requests, Check suites, Workflow runs**. Every delivery is verified with
`X-Hub-Signature-256`; a replayed `X-GitHub-Delivery` is refused with 409 and
recorded as `gateway_rejected`.

## Alertmanager

```yaml
receivers:
  - name: aria
    webhook_configs:
      - url: https://app.suderra.com/aria/webhook/alertmanager
        http_config:
          authorization: { type: Bearer, credentials: <ARIA_ALERTMANAGER_BEARER> }
```

`firing` becomes a runtime signal (`source=incident`); `resolved` is recorded only.

## Operator commands over HTTP

```bash
curl -sS -X POST https://app.suderra.com/aria/webhook/operator \
  -H "Authorization: Bearer $ARIA_OPERATOR_BEARER" -H "X-Aria-Actor: <github-login>" \
  -H 'Content-Type: application/json' -d '{"verb":"pause","reason":"deploy window"}'
```

The actor must be in `ARIA_GATEWAY_ACTOR_ALLOWLIST`; the verb vocabulary is
`pause | resume | cancel` (cancel needs `request_id`). The same commands work
offline: `aria-kernel control pause|resume|cancel`.

## Schedules

```bash
aria-kernel schedule add --name nightly-cycle --action cycle --cron "0 2 * * *"
aria-kernel schedule add --name nightly-drain --action drain --cron "30 2 * * *"
aria-kernel schedule add --name doctor --action doctor --cron "*/30 * * * *"
aria-kernel schedule list | pause | resume | remove --name <name>
aria-kernel schedule run --action inbox_drain      # run one action now
```

Workflow actions call `gh workflow run <workflow> --ref main` and are skipped
while `control pause` is in effect. Every run lands on
`gateway/schedules.jsonl` (`ran`) and `governance.jsonl` (`gateway_action_ran`).

## Health

- `aria-kernel doctor` → organ `gateway` (heartbeat age, inbox backlog).
- `curl -s https://app.suderra.com/aria/status` → read-only JSON (no secrets).
- `aria-kernel gateway status` → inbox counts + schedule table.
- Stop cleanly: `touch /var/aqua-saas/aria-tools/ARIA_STOP` or `systemctl stop aria-gateway`.
- A second instance exits with `daemon_already_running`; a lease held by another host exits with `host_lease_blocked`.

## Offline replay / testing

```bash
aria-kernel event ingest --source github --github-event issues --payload-file issue.json --route
aria-kernel event ingest --source alertmanager --payload-file alerts.json
aria-kernel event route          # drain whatever the daemon has not routed yet
```
