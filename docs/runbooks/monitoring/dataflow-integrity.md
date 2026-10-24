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

## Signal hygiene

When a condition clears, close the ARIA side:
`aria-kernel runtime signal resolve --signal-id <id> --resolution-note "<what fixed it>"`.

## Privileged probe install (container_state_truth, tenant_reality_parity)

The hourly watchdog (`.github/workflows/dataflow-integrity-watchdog.yml`) runs
on the self-hosted runner as `gharunner`, which has no docker access and no
way to gain privilege: its unit carries `SupplementaryGroups=` and
`NoNewPrivileges=yes` (ADR-0023,
`scripts/aria/runner-habitat/systemd/actions-runner.identity.conf`). The
docker group would be root by another name, and `NoNewPrivileges` makes sudo
inert for every job, so a sudoers rule could never run anything for it. The
two probes that need root-only facts therefore read them from a root-owned
probe over a socket:

| Piece   | Source in the repository                                     | Installed as                                                                                                                              |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Probe   | `infrastructure/scripts/aqua-dataflow-probe.sh`              | `/usr/local/sbin/aqua-dataflow-probe`, `root:root` `0755`                                                                                 |
| Socket  | `infrastructure/dataflow-probe/aqua-dataflow-probe.socket`   | `/etc/systemd/system/aqua-dataflow-probe.socket`, `root:root` `0644`; listens on `/run/aqua-dataflow-probe.sock`, `root:gharunner` `0660` |
| Service | `infrastructure/dataflow-probe/aqua-dataflow-probe@.service` | `/etc/systemd/system/aqua-dataflow-probe@.service`, `root:root` `0644`                                                                    |
| Client  | `tools/watchdog/privileged-evidence.mjs`                     | runs in the job, from the checkout                                                                                                        |

What a connection can do: start one run of the fixed probe (no argument is
accepted, nothing sent on the connection is read) and receive its JSON. The
probe runs only `docker ps`, `docker inspect`, and `docker exec aqua-postgres
psql` with `default_transaction_read_only=on` and a 20 s `statement_timeout`.
The one statement it runs returns tenant statuses and schema facts, never a
tenant id or name. `tests/invariants/dataflow-watchdog-privileged-probe.spec.ts`
and `tools/watchdog/privileged-evidence.spec.mjs` pin these properties. The
runner gets no group, no sudo rule and no docker access.

### Install (program lead, after review)

From a checkout of the reviewed commit on `main`, as root:

```bash
install -o root -g root -m 0755 infrastructure/scripts/aqua-dataflow-probe.sh /usr/local/sbin/aqua-dataflow-probe
install -o root -g root -m 0644 infrastructure/dataflow-probe/aqua-dataflow-probe.socket /etc/systemd/system/aqua-dataflow-probe.socket
install -o root -g root -m 0644 'infrastructure/dataflow-probe/aqua-dataflow-probe@.service' '/etc/systemd/system/aqua-dataflow-probe@.service'
systemctl daemon-reload
systemctl enable --now aqua-dataflow-probe.socket
```

### Verify

```bash
stat -c '%U:%G %a %n' /usr/local/sbin/aqua-dataflow-probe /run/aqua-dataflow-probe.sock
# root:root 755 /usr/local/sbin/aqua-dataflow-probe
# root:gharunner 660 /run/aqua-dataflow-probe.sock
/usr/local/sbin/aqua-dataflow-probe --anything; echo "exit $?"   # refused: exit 64, nothing printed
setpriv --reuid=gharunner --regid=gharunner --clear-groups \
  node -e "require('net').connect('/run/aqua-dataflow-probe.sock').pipe(process.stdout)"
# one JSON document: {"container_state_truth":{...},"tenant_reality_parity":{"tenants":[...]}}
journalctl -u 'aqua-dataflow-probe@*' --since -10min   # docker/psql diagnostics, if any
```

Then dispatch the watchdog once (`gh workflow run dataflow-integrity-watchdog.yml`).
In its `probe-evidence` artifact, `container_state_truth` and
`tenant_reality_parity` should report a measurement and no `probe-error`.

### Upgrade and removal

When either file changes on `main`, re-run the matching `install` line. The
next connection runs the new probe, and `systemctl daemon-reload` picks up a
changed unit. To remove the probe:
`systemctl disable --now aqua-dataflow-probe.socket`, then delete the three
installed files. Both probes then report `probe-error` (connection refused)
again. They never report green.
