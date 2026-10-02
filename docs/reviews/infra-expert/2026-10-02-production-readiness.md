# Deployment topology, backup/DR and operability — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `infra-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | docker-compose.droplet.yml, scripts/deploy/*, backup/PITR/WAL workflows, nginx, monitoring |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

There is no working backup, no alert reaches a person, and everything runs on one droplet whose
container memory limits add up to more than the host has.

## Real production target

- A single DigitalOcean droplet (app.suderra.com) running the compose project `aqua-saas`. The
  production lane is locked (`deploy-digitalocean.yml:125-143`).
- Every push to main still deploys through `deploy-development.yml` (`ci-affected.yml:1279-1290`)
  with the repo-level `DROPLET_HOST`, and runs db-migrate against the live database
  (`deploy-development.yml:189`). The 2026-09-27 stall review (lines 120-128) suggests this is the
  same host the backup lanes probe.

## Blockers

- **B1. No disaster recovery exists.**
  - `.github/manifests/dr-activation.json:6-24` marks both WAL archiving and logical backup
    `not-activated`: archive_mode is off and the backup secrets were never provisioned.
  - PITR is dispatch-only (`pitr-restore-production.yml:8`). No drill log exists
    (`docs/runbooks/_logs/` is absent). Nothing backs up MinIO, Redis or JetStream.
  - The stated RPO of 300 s and RTO of 3600 s (runbook lines 362-367) cannot be met: losing the
    host or volume means losing all data.
- **B2. Alerts reach no one.**
  - `infrastructure/monitoring/droplet/alertmanager.yml:33-36,75,89` are placeholders.
    `render-configs.sh` runs only from the manual `monitoring-up.sh:64`.
  - The droplet-compose Alertmanager sits only on `aqua-internal`, which is `internal: true`
    (compose `:228-230`, `2225-2226`), so it has no egress even after rendering.
  - The heartbeat at 127.0.0.1:9099 is unwired, so there is no dead-man switch.
- **B3. Capacity and single points of failure.**
  - 40 services, not 45. Postgres, Redis, NATS and MinIO each run as one instance.
  - The compose header says 4 CPU / 8 GB (`:2-4`), but memory limits add up to about 10.5 GiB;
    rule `35-broker-jetstream.yml:53-63` admits the oversubscription.
  - The 2026-09-27 review shows 13% disk free and volumes growing about 8 GB/day. A full deploy
    runs `compose down` on everything (`droplet-up.sh:1282`).

## Major

- **M4. Postgres health is tied to WAL RPO.** The healthcheck uses the WAL-G check with `retries:
  1` (compose `:369-373`). Postgres is unhealthy right now (INFRA-HIGH-191, OPEN), which blocks
  deploys.
- **M5. JetStream limits disagree and will block deploys.** `nats.conf:20` sets 10GB, but
  `droplet-up.sh:1315-1319` and `:1511-1515` abort every deploy above 1800 MB,
  `droplet-capacity.sh:78` uses 1920 MiB and rule 35 alerts at 1.5 GiB.
- **M6. Unsafe deploy control plane.**
  - None of the `appleboy/ssh-action` steps pin the host key (`deploy-digitalocean.yml:1187`,
    `:1272`; `deploy-development.yml:86`, `:179`).
  - The WAL lane's fingerprint mismatch is unexplained: either the host key changed or someone is
    in the middle.
  - Deploy scripts load `node_modules` symlinked from the mutable interactive tree
    (`deploy-paths.sh:152-154`).
- **M7. Rollback is fix-forward only.** It swaps images back but refuses once any migration has
  applied (`droplet-up.sh:522-536`), and there is no PITR to fall back on.

## Minor

- TLS renewal is not in the repo: no certbot setup or renew job, and no alerts for cert expiry,
  disk, Postgres or Redis. The nginx TLS, HSTS, CSP and `/metrics` blocks are fine
  (`droplet.conf:168-194`, `:276-279`).
- Floating image tags: `redis:7-alpine` (compose `:504`, `:563`) and `minio/mc:latest`
  (`droplet-up.sh:249`).
- Helm, k8s and Terraform are aspirational: Helm is only linted and templated
  (`ci-affected.yml:1141-1169`), no workflow runs `infra/terraform` (AWS EKS/RDS), and
  `docker-compose.prod.yml` is not used for deploys.

## Registry and first-pass claims

| Item | Status | Evidence |
| ---- | ------ | -------- |
| DEPLOY-CRITICAL-017 | CONFIRMED | Destructive cleanup still matches containers by `aqua-` name (`droplet-up.sh:1285-1304`); monitoring is still duplicated at compose `:2131-2230` |
| "label filter fixes it" (orchestrator first pass) | REFUTED | The label filter is only in the log dump at `droplet-up.sh:273` |
| ORPHAN-CRITICAL-810 | CONFIRMED in substance | Declared custom image and root entrypoint (compose `:277`, `:336`) vs `dr-activation.json:10` saying the base image runs |
| INFRA-CRITICAL-077 | CONFIRMED | The lock exists only in `production-host-control-plane.sh`, which no workflow runs; GC and deploys use three different concurrency groups and no shared lock |
| INFRA-CRITICAL-093 | STALE | Fixed in code (`production-host-control-plane.sh:2998-3013`) but the script is not wired into any workflow |
| INFRA-CRITICAL-078 | CONFIRMED | Also applies to `deploy-development.yml` |
| WAL fingerprint failure | CONFIRMED | 2026-09-27 stall review |
| NATS 10GB vs 2GiB rule | CONFIRMED | Also extends to the deploy gates (M5) |

## Orchestrator verification

- Verified in the working tree: both capabilities `not-activated` in `dr-activation.json`;
  Alertmanager attached only to `aqua-internal` with `internal: true`; placeholder SMTP
  credentials; summed compose memory limits of about 11 GiB against an 8 GB header; the `aqua-`
  name-based force-removal in `droplet-up.sh`; the 1800 MB JetStream gate; the rollback refusal;
  the floating tags.
- Not re-checked: the 13% disk and 8 GB/day figures (taken from the 2026-09-27 review).

## Not verified

- Live host RAM, disk and running containers; whether `aqua-monitoring` is up; the GitHub
  variables `PRODUCTION_DEPLOY_ENABLED` and `STAGING_ENABLED`; whether the repo-level and
  production-environment `DROPLET_HOST` are the same host; whether main CI is red (the
  orchestrator found it is); actual cert expiry.

## Registry entries

This review appended 4 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| INFRA-CRITICAL-198 | CRITICAL | Production has no activated backup or restore capability: dr-activation.json declares WAL archiving and logical backup not-activated (archive\_mode off, none of the twelve backup secrets ever provisioned), no restore drill is logged, and MinIO, Redis and JetStream are in no backup, so the declared 300 s RPO and 3600 s RTO have nothing behind them |
| INFRA-CRITICAL-199 | CRITICAL | The droplet Alertmanager can notify no one: its SMTP and receiver settings are placeholders, render-configs.sh runs only from the manual monitoring-up.sh, the container sits only on the internal: true aqua-internal network with no egress, and the heartbeat dead-man endpoint is unwired |
| INFRA-HIGH-200 | HIGH | The droplet compose promises about 11 GiB of container memory limits on a host documented as 4 CPU / 8 GB with a ~7 GB budget, runs 40 services as single instances (Postgres, Redis, NATS, MinIO), and a full deploy runs compose down on everything, with 13% disk free and volumes growing about 8 GB/day at the last review |
| INFRA-MEDIUM-201 | MEDIUM | No TLS certificate-expiry alert exists in the droplet Prometheus rules, and no certificate renewal job for the production host is present in scripts/ or the workflows, so an expiring certificate would take the site down without warning |
