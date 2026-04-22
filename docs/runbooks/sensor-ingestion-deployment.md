# Runbook: sensor-ingestion Initial Deployment + Secret/Cert Rotation

**Owner:** platform team (Okan-Wqm + SRE)
**Related ADRs:** ADR-014/015 (NATS cert-only identity), ADR-025 (Rust sidecar architecture), ADR-027 (per-tenant IngestBackend toggle), ADR-032 (Rust binary supply-chain hardening)
**Related runbooks:** `sensor-ingest-rust-rollout.md` (per-tenant strangler-fig flip), `secret-rotation.md` (platform-wide secret patterns), `nats-service-addition.md` (services.yaml SSoT workflow)

## Purpose

Cover **initial deployment**, **secret + cert provisioning**, and **rotation** for the Rust sensor-ingestion sidecar. This runbook is pre-rollout: once the sidecar is deployed and healthy, `sensor-ingest-rust-rollout.md` takes over for the per-tenant flip.

Rollout flip + deployment are strictly separate — a broken config is detected at deploy time (container fails health check, restart loop) and never reaches tenant traffic. Confidence comes from the layered checks here, not from the rollout-gate.

---

## Prerequisites

Before running any step in this runbook:

- [ ] `infrastructure/nats/services.yaml` contains `sensor_ingestion` entry (ADR-014/015 SSoT).
- [ ] `infrastructure/nats/services.schema.json` permits every subject the sidecar publishes/subscribes (including the `policy.` namespace added for ADR-027 + ADR-031).
- [ ] `scripts/nats/generate-nats-conf.py` produces `infrastructure/docker/nats/nats.conf` with no drift (run `--dry-run` to verify).
- [ ] The per-service cert for `sensor_ingestion` CN is minted via `infrastructure/docker/scripts/generate-internal-certs.sh` (idempotent; skipped if present).
- [ ] The target image `ghcr.io/okan-wqm/aquaculture_platform/sensor-ingestion:${TAG}` exists in GHCR and passes cosign verification (see §6 below — ADR-032).
- [ ] Operator has `docker compose` admin privilege on the droplet OR `kubectl apply` equivalent on the target cluster.

---

## 1. Initial deployment — DigitalOcean droplet

DigitalOcean compose is `docker-compose.droplet.yml`. The `sensor-ingestion` service block already lives in that file (ADR-025 strangler-fig staging); this section covers what the operator does to **activate** that service for the first time.

### 1a. Provision the cert directory

The sidecar mounts certs from `./certs/sensor-ingestion/` at container path `/etc/sensor-ingestion/certs/`. Generate them on the droplet (or copy from a trusted build machine):

```bash
# On the droplet, from the repo root:
bash infrastructure/docker/scripts/generate-internal-certs.sh
# Verify the sensor_ingestion CN cert is in place:
ls -la certs/nats/clients/sensor_ingestion-cert.pem certs/nats/clients/sensor_ingestion-key.pem
```

The cert generator derives its CN list from `infrastructure/nats/services.yaml` (no hand-edited duplicate list — BACKLOG-NATS-002 closed). Adding `sensor_ingestion` to services.yaml is all that is needed for the cert to be minted.

### 1b. Stage the `config.toml` with secrets

Copy the example template:

```bash
cp infrastructure/sensor-ingestion/config.toml.example \
   infrastructure/sensor-ingestion/config.toml
```

Edit the staged file — the **only** field that needs operator input is the Postgres password. Everything else is environment-independent:

```toml
[postgres]
# sensor_ingestion is a dedicated PG role — apply the schema-per-tenant
# RLS policy (ADR-030) so a missing SET LOCAL app.current_tenant trips
# the policy at write time instead of silently cross-contaminating.
user = "sensor_ingestion"
password = "<the sensor_ingestion PG role password from the platform vault>"
```

The password is never checked into git — `.claude/settings.json` deny-rule blocks any commit touching `.env` or a `config.toml` outside of the `.example` filename. If a `config.toml` diff ever reaches `git add`, stop and investigate before proceeding.

### 1c. Bring up the sidecar

```bash
docker compose -f docker-compose.droplet.yml up -d sensor-ingestion
docker logs -f aqua-sensor-ingestion
```

**Expected boot log sequence (healthy):**

```
INFO sensor_ingestion: starting version 0.1.0
INFO sensor_ingestion::mqtt: connected mqtts://mosquitto:8883
INFO sensor_ingestion::nats: connected tls://nats:4222 (cn=sensor_ingestion)
INFO sensor_ingestion::policy: requesting policy.ingest_backend.snapshot (timeout 5s)
INFO sensor_ingestion::policy: snapshot received — global=node overrides=0 tenants
INFO sensor_ingestion::persistence: postgres pool size=4 connected
INFO sensor_ingestion::main: MQTT subscribe active (2 topic filters, QoS=1)
```

The `policy.ingest_backend.snapshot` line is authoritative for ADR-031 cold-start — if it is missing or takes longer than the 30s max wait, the sidecar has fallen back to `/var/lib/sensor-ingestion/last-known-policy.json` and raised `sensor_ingestion_boot_policy_fallback_total`. Follow §5 to diagnose.

### 1d. Verify end-to-end with a canary tenant

Before the first production tenant flip, validate with a synthetic tenant. The `sensor-ingest-rust-rollout.md` runbook covers this step in full — at this stage the sidecar is deployed but every tenant is still on the `node` backend (ADR-027 default).

---

## 2. Production Kubernetes deployment

When the cluster migration lands, the compose `secrets:` pattern is replaced by Kubernetes Secrets. The mount paths inside the container are unchanged (`/etc/sensor-ingestion/certs/`, `/etc/sensor-ingestion/config.toml`) — the container sees the same file layout.

Equivalent workflow:

1. Create the PG password Secret:
   ```bash
   kubectl create secret generic sensor-ingestion-db \
     --from-literal=password='<vault value>' \
     --namespace=aquaculture-prod
   ```
2. Mount via the Helm chart (`infrastructure/helm/aquaculture/templates/sensor-ingestion-deployment.yaml` — pending first chart commit) using `subPath` to produce the same `/etc/sensor-ingestion/config.toml` path.
3. Mount per-service cert + key from a sealed-secret synced from the platform CA (External Secrets Operator).
4. `kubectl rollout status deployment/sensor-ingestion` — success = log pattern in §1c.

---

## 3. Cert rotation

Per-service NATS mTLS certs are minted by `infrastructure/docker/scripts/generate-internal-certs.sh` with a 365-day validity. Rotation is **three steps** that MUST happen in order — the script regenerates the in-place files, so rollback is just `git reset` on the cert directory before the restart.

1. **Mint the new certs** on the build machine:
   ```bash
   FORCE=true bash infrastructure/docker/scripts/generate-internal-certs.sh
   ```
   `FORCE=true` overwrites the existing cert files (default behaviour is skip-if-present). The CA itself is NOT rotated by this script — CA rotation is separately covered in a future ADR.

2. **Copy to every droplet + cluster secret store** — the certs live under `certs/nats/clients/` in the repo working tree; deploy pipelines rsync or sealed-secret-sync them.

3. **Rolling restart** of every service that uses mTLS, starting with `nats` itself (new CA-signed server cert), then per-service in dependency order:
   ```bash
   docker compose -f docker-compose.droplet.yml restart nats
   # Wait for nats health check to pass (10-20 s)
   docker compose -f docker-compose.droplet.yml restart sensor-ingestion
   # Verify connection in logs: "connected tls://nats:4222 (cn=sensor_ingestion)"
   ```

`verify_and_map: true` + per-service CN means a stale cert is not accepted — if the sidecar fails to reconnect, the log carries `unauthorized: mTLS identity CN=sensor_ingestion not in authorization{} users`. Check that `scripts/nats/generate-nats-conf.py` ran against the updated services.yaml before the NATS container restart.

---

## 4. DB password rotation

The `sensor_ingestion` PG role password rotation is zero-downtime if timed correctly.

1. Pick a rotation window. MQTT QoS-1 inflight persistence covers ≤ 30 s outages — the window is the restart time of the sidecar.
2. On the PG primary:
   ```sql
   ALTER ROLE sensor_ingestion PASSWORD '<new secret>';
   ```
   The existing sidecar connection stays open (PostgreSQL does NOT terminate sessions on role-password change). New connections use the new password.
3. Update `config.toml` on every droplet (or the Kubernetes Secret).
4. Restart the sidecar:
   ```bash
   docker compose -f docker-compose.droplet.yml restart sensor-ingestion
   ```
5. Verify log line `postgres pool size=4 connected`. A failed reconnect carries `postgres: FATAL: password authentication failed for user "sensor_ingestion"` — roll back the `ALTER ROLE` if this appears.

The existing connection from step 2 is eventually recycled by the pool (30 s idle timeout via deadpool-postgres default), so all connections end up on the new password without an explicit drop.

---

## 5. Troubleshooting

### 5.1 Cold-start policy snapshot timeout

Symptom: `sensor_ingestion_boot_policy_fallback_total` counter > 0 + log line `WARN policy.snapshot timed out after 30s — falling back to /var/lib/sensor-ingestion/last-known-policy.json`.

Root causes + fixes:

- **NATS server down**: `docker compose ps nats` — if unhealthy, the sidecar is in degraded mode; restore NATS, then `docker compose restart sensor-ingestion` to re-fetch the snapshot.
- **admin-api-service responder missing**: the `policy.ingest_backend.snapshot` responder is registered by admin-api (ADR-031). If admin-api is down, no responder replies; same fallback applies. Check `admin-api-service` logs for the `registered nats responder policy.ingest_backend.snapshot` line.
- **services.yaml ACL missing `policy.ingest_backend.*`**: an upgrade missed the subject ACL entries. Run `python3 scripts/nats/generate-nats-conf.py --dry-run` and verify. Regenerate and restart NATS + admin-api + sidecar.

Never disable the snapshot requirement — the sidecar fails closed on purpose (MQTT subscription blocked), and silent default-policy routing is banned by the architectural rules.

### 5.2 RLS policy rejection on COPY

Symptom: `SinkError::InvalidRow { reason: "tenant context not set — RLS rejected write" }` in sidecar logs.

Root cause: a write path constructed a `ScopedTx` incorrectly (ADR-030). This is a code bug, not an operational one. Capture the batch that failed, file a CRITICAL severity bug against the Rust sidecar, and operationally roll back to the Node backend for the affected tenant via `config.toml` `[ingest_backend]` override.

### 5.3 Cosign verify failure during image pull

Symptom: deploy pipeline halts before `docker compose up` with `cosign: verification failed`.

Root cause (ADR-032): a GHCR image push bypassed the signing step. Never override — the verification is the trust chain. Re-run the publish pipeline for that SHA with cosign sign step intact; verify the Rekor transparency-log URL in the CI output before retrying the pull.

---

## 6. Supply-chain verification (ADR-032)

Every deploy pulls an image via:

```bash
# Pinned workflow identity + issuer; matches ADR-032 §Part A, item 4.
cosign verify \
  --certificate-identity-regexp \
    'https://github\.com/Okan-wqm/aquaculture[-_]platform/.+@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/okan-wqm/aquaculture_platform/sensor-ingestion:${TAG}
```

The deploy script (`deploy-digitalocean.yml`) runs this step before `docker compose pull`; a failure aborts the deploy with a clear error. Manual verification on the droplet:

```bash
cosign tree ghcr.io/okan-wqm/aquaculture_platform/sensor-ingestion:${TAG}
# Shows the signature + the SBOM attestation. Missing either = do not pull.
```

The SBOM can be extracted for vulnerability scanning:

```bash
cosign download attestation \
  --predicate-type spdxjson \
  ghcr.io/okan-wqm/aquaculture_platform/sensor-ingestion:${TAG} \
  | jq -r '.payload' | base64 -d \
  > sensor-ingestion.sbom.spdx.json
```

Feed `sensor-ingestion.sbom.spdx.json` to Trivy / Grype for the current-state CVE posture.

---

## 7. Rollback

If the sidecar starts but cannot establish healthy operation (NATS reconnect loop, persistent RLS error, policy-snapshot fallback that does not recover):

1. **Operational rollback** — flip every opted-in tenant back to `node` in `config.toml` `[ingest_backend].tenant_overrides` → restart sidecar. The sidecar becomes a no-op for every tenant; the Node backend continues serving. This is the safer first move.
2. **Image rollback** — `TAG=<previous-known-good-SHA>` in the deploy env, `docker compose up -d sensor-ingestion`. cosign verify validates the previous image; its SBOM is archived from the previous build.
3. **Stop the sidecar entirely** — `docker compose stop sensor-ingestion`. Node backend owns 100 % of ingestion; the MQTT broker buffers nothing because the sidecar's subscription is scoped (Node's subscription is separate and always active).

Post-rollback: capture logs + `docker compose ps` state, open a CRITICAL severity finding in `docs/reviews/orphan-findings.md`, and coordinate the root-cause analysis before re-deploying.

---

## 8. Known open dependencies (tracked findings)

- `ORPHAN-019` — `@platform/event-bus` NATS request-reply API must be merged for §5.1 fallback to be rare; until that PR lands, every fresh droplet boot will exercise the fallback path once.
- `ORPHAN-020` — `apps/db-migrate` rollback CLI is the authoritative way to revert V017 (RLS) if §5.2 root cause is a bad migration; until its verification lands, the rollback path is manual DDL documented in the ADR-030 migration file.

Each finding carries owner + deadline; check `docs/reviews/orphan-findings.md` for current status before relying on the associated workflow.
