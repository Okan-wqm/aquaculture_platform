# Runbook: Staging Environment (WS9 / ADR-016 Phase D)

Operator runbook for the staging droplet. Provisioning, first-run secret seeding, staging-to-prod promotion, the emergency gate bypass, and cost-minimising teardown.

**Scope:** a single DigitalOcean droplet running the SAME compose stack as production (via `docker-compose.droplet.yml` + `docker-compose.staging.yml` overlay), deployed automatically on every push to `main`. Prod deploy is gated on staging success.

**Not in scope:** multi-tenant staging, performance testing, or full DR drill. Those build on top of this runbook.

---

## Why staging exists

The 2026-04-14 cascade (ADR-016) lost ~90 minutes of production availability because five shape-errors chained together in ways CI cannot catch: compose interpolation at runtime, NATS auth mode, schema drift, migration races. Staging runs the full compose stack for every commit and catches those failures before a live user sees them.

See `docs/adr/016-deploy-resilience-architecture.md#phase-d-staging-environment-roadmap-biggest-single-win`.

---

## Architecture

```
                    push to main
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   CI - Affected (lint+test)    (no direct prod path)
          │
          ▼
   Deploy to Staging  ←───── reads docker-compose.droplet.yml
          │                    + docker-compose.staging.yml
          │                    + required-secrets.yaml
          │                    + service-criticality.yaml
          │                    + required-signals.yaml
          │
          ▼ (on success)
   tag: deployed/staging-<sha>
          │
          ▼
   Deploy to DigitalOcean (prod)  ←── staging-gate job asserts tag
          │
          ▼ (on success)
   tag: deployed/production
```

Staging reuses the prod droplet compose shape unchanged; only image tags, resource limits, CORS origins, Stripe sandbox keys, and container names differ. This makes staging-prod drift structurally impossible (Tier-1 Make-Impossible): if prod gets a new service, staging inherits it automatically.

---

## Prerequisites (one-time operator tasks)

Before running `terraform apply` the operator must:

1. **Register an SSH key in DigitalOcean.** Account → Security → SSH keys → Add SSH Key. Paste the public key. Note the **name** — that's what the Terraform `ssh_key_name` variable wants. Terraform will NOT create this key (private keys belong on the operator's machine, not in tfstate).

2. **(Optional) Reserve an IP in DigitalOcean.** Networking → Reserved IPs → Reserve IP. Note the IPv4 address. This keeps DNS stable across droplet destroy/recreate cycles — recommended if you plan to rebuild the staging droplet.

3. **Add the base domain to DigitalOcean DNS.** Networking → Domains → Add Domain. Terraform creates the `staging.<domain>` A record but the parent zone must already exist.

4. **Authenticate doctl / the DigitalOcean provider.** Export `DIGITALOCEAN_TOKEN` with an account-scoped API token. The token must have read + write on Droplets, Networking, Spaces, and Projects.

5. **Authenticate Spaces access.** Generate Spaces access keys (Account → API → Spaces Keys). Export them on the provisioning machine:
   ```
   export SPACES_ACCESS_KEY_ID=DO00XXXXXXXXXXXXXXXX
   export SPACES_SECRET_ACCESS_KEY=<secret>
   ```
   Terraform needs these to manage the backup bucket's lifecycle rules.

---

## Provision (Terraform)

Create an environment root module at `infrastructure/terraform/environments/staging/main.tf` (not part of WS9 Phase 1; tracked in the plan as WS9 Phase 2 — "operator provisions actual droplet"). The module wires the `staging-droplet` module:

```hcl
module "staging" {
  source = "../../modules/staging-droplet"

  project_name         = "aquaculture"
  region               = "fra1"
  domain               = "suderra.com"                # staging FQDN will be staging.suderra.com
  ssh_key_name         = "okan-macbook-pro"           # matches DO account SSH key name
  ssh_allowed_cidrs    = ["1.2.3.4/32", "5.6.7.8/32"] # operator bastion / office CIDRs
  reserved_ip          = "203.0.113.42"               # optional; null = dynamic droplet IP
  spaces_region        = "fra1"
  droplet_size         = "s-2vcpu-4gb"                # default
  backup_retention_days = 3                           # default

  # cloud_init_user_data is OPTIONAL — see below for a reference script.
}
```

Then:

```
cd infrastructure/terraform/environments/staging
terraform init
terraform plan
terraform apply
```

Outputs to capture (seed into the GitHub `staging` environment):
- `staging_fqdn`        → used as `STAGING_DROPLET_HOST` secret (unless you use the Reserved IP)
- `droplet_ipv4`        → alternative `STAGING_DROPLET_HOST` value
- `spaces_bucket_name`  → used by the backup script on the droplet
- `next_step_reminder`  → reminder that secret seeding is the next step

---

## First-run secret seeding

Staging secrets live on the staging droplet at `/var/aqua-saas/.env`. They are NEVER stored in Terraform state, NEVER in .tfvars, NEVER in the compose file. Seeding is a one-shot procedure at droplet provision time; rotations follow the production procedure in `docs/runbooks/secret-rotation.md`.

The canonical list of required secrets is `infrastructure/deploy/required-secrets.yaml` (WS8 SSoT — any `${VAR:?...}` reference in compose appears here).

### Procedure

1. **SSH into the staging droplet.**
   ```
   ssh root@staging.suderra.com
   mkdir -p /var/aqua-saas && cd /var/aqua-saas
   git clone --branch main https://github.com/Okan-wqm/aquaculture_platform.git .
   ```

2. **Generate fresh random secrets for staging.** DO NOT copy production secrets. Staging values must be distinct so a staging compromise cannot turn into a prod compromise.
   ```
   generate() { openssl rand -base64 32 | tr -d '/+=' | head -c 32; }

   cat > /var/aqua-saas/.env <<EOF
   # Database (ALL DISTINCT FROM PROD)
   POSTGRES_USER=aquaculture
   POSTGRES_PASSWORD=$(generate)
   POSTGRES_DB=aquaculture
   AUTH_SERVICE_DB_PASS=$(generate)
   FARM_SERVICE_DB_PASS=$(generate)
   SENSOR_SERVICE_DB_PASS=$(generate)
   BILLING_SERVICE_DB_PASS=$(generate)
   HR_SERVICE_DB_PASS=$(generate)
   ALERT_SERVICE_DB_PASS=$(generate)
   ADMIN_SERVICE_DB_PASS=$(generate)
   GATEWAY_SERVICE_DB_PASS=$(generate)
   NOTIFICATION_SERVICE_DB_PASS=$(generate)
   HYDROPONICS_SERVICE_DB_PASS=$(generate)
   MESSAGING_SERVICE_DB_PASS=$(generate)

   # Redis / NATS / encryption
   REDIS_PASSWORD=$(generate)
   INTERNAL_SERVICE_SECRET=$(generate)
   PASSWORD_PEPPER=$(generate)
   ENCRYPTION_KEY=$(generate)
   CREDENTIAL_ENCRYPTION_KEY=$(generate)
   WEBHOOK_ENCRYPTION_KEY=$(generate)

   # MinIO (staging droplet)
   MINIO_USER=$(generate)
   MINIO_PASSWORD=$(generate)
   MINIO_BUCKET=aquaculture-staging

   # MQTT (sensor ingestion)
   MQTT_AUTH_SECRET=$(generate)
   MQTT_SENSOR_SERVICE_PASSWORD=$(generate)
   MQTT_SENSOR_SERVICE_HASH=<pre-computed via mosquitto_passwd; see secret-rotation.md>

   # Observability / admin
   OBSERVABILITY_INTERNAL_API_KEY=$(generate)
   SUPER_ADMIN_EMAIL=admin+staging@suderra.com
   SUPER_ADMIN_PASSWORD=$(generate)

   # Staging-specific domain overrides
   CORS_ORIGINS=https://staging.suderra.com
   FRONTEND_URL=https://staging.suderra.com
   WEBAUTHN_RP_ID=staging.suderra.com
   WEBAUTHN_RP_NAME=AquaCulture Platform (Staging)

   # Stripe sandbox — LEAVE EMPTY until Stripe onboarding. Billing-service
   # degrades gracefully (rejects webhooks 400) without these.
   # STRIPE_WEBHOOK_SECRET_SANDBOX=whsec_test_...
   # STRIPE_API_KEY_SANDBOX=sk_test_...
   EOF
   chmod 600 /var/aqua-saas/.env
   ```

3. **Validate the seed.** Dry-run the compose interpolation against the merged file:
   ```
   docker compose -f docker-compose.droplet.yml -f docker-compose.staging.yml config --quiet
   ```
   Any missing `${VAR:?...}` fails here. Cross-reference with `infrastructure/deploy/required-secrets.yaml`.

4. **Configure GitHub secrets.** In GitHub → Settings → Environments → `staging`:
   - `STAGING_DROPLET_HOST`     → `staging.suderra.com` (or Reserved IP)
   - `STAGING_DROPLET_USER`     → `root` (or whatever SSH user you set up)
   - `STAGING_DROPLET_SSH_KEY`  → the private key matching the DO-registered public key

5. **Trigger the first deploy.** Either push a commit to `main` or run `workflow_dispatch` on `Deploy to DigitalOcean (Staging)`. Confirm in the Actions tab.

### Reference mosquitto password hash

The MQTT sensor-service password hash uses mosquitto's PBKDF2:

```
docker run --rm -it eclipse-mosquitto mosquitto_passwd -c -H sha512 -b - sensor_service '<MQTT_SENSOR_SERVICE_PASSWORD>' | tail -n 1 | cut -d: -f2
```

Copy the resulting `$7$...` string into `MQTT_SENSOR_SERVICE_HASH`. Rotate this hash whenever the password rotates (they travel as a pair — see the secret-rotation runbook).

---

## Promote staging to production

Staging success does NOT auto-promote. The operator reviews staging, confirms everything works, then triggers production.

### Automatic path (normal case)

1. Push to `main`. `deploy-staging.yml` builds + deploys to staging + runs WS6 criticality gate + WS7 signal assertion.
2. On success, the staging workflow pushes the tag `deployed/staging-<sha>`.
3. Separately, `Deploy to DigitalOcean` (prod) was triggered by the CI workflow. Its `staging-gate` job polls for the `deployed/staging-<sha>` tag (up to 55 min). When it finds the tag, prod deploy proceeds.

### Manual promote (after reviewing staging)

1. Verify staging health out-of-band:
   - Open `https://staging.suderra.com` and run smoke tests.
   - SSH in and check container logs: `docker compose -f docker-compose.droplet.yml -f docker-compose.staging.yml logs --tail 200`.
   - Check metrics / Grafana under the `staging` namespace.
2. In GitHub → Actions → `Deploy to DigitalOcean` → Run workflow. Inputs:
   - `services: all` (or comma-separated list)
   - `bypass_staging_gate: false` (the default)
3. The prod staging-gate sees `deployed/staging-<sha>` and passes immediately.

### Emergency bypass (CVE / staging outage)

**Use only when:** staging itself is broken, the production issue cannot wait, and you have an incident ID and manager approval.

1. Document the bypass reason in your incident ticket.
2. Trigger `Deploy to DigitalOcean` via `workflow_dispatch`:
   - `bypass_staging_gate: true`
   - `bypass_reason: "INC-<id>: staging droplet offline; CVE-XXXX-YYYY fix"`
3. The gate job logs the bypass with `::warning::` and proceeds. The bypass is visible in the workflow run log — do not try to hide it.
4. After the hotfix lands, immediately deploy a follow-up commit through the normal path to re-establish the staging/prod invariant. Staying in bypass for >24h = HIGH finding per infra-expert review.

---

## Observe staging

### Container health

```
ssh root@staging.suderra.com 'cd /var/aqua-saas && docker compose -f docker-compose.droplet.yml -f docker-compose.staging.yml ps'
```

### Metrics

Staging-emitted metrics carry `METRICS_NAMESPACE=staging` labels. Grafana dashboards under "Platform / Staging" filter by that label. If a panel looks empty, the service probably doesn't read `METRICS_NAMESPACE` yet — the env var is ready for consumption when the services wire it in.

### Logs

Aggregated via Loki (if deployed to staging) or `docker compose logs <service>` directly. Prefer the former for cross-service trace analysis.

---

## Destroy / teardown (cost reasons)

Staging costs ~24 USD/mo idle. If you genuinely don't need staging for a long stretch, tear it down:

```
cd infrastructure/terraform/environments/staging
terraform destroy
```

Notes:
- The Spaces bucket is `prevent_destroy = true`. Backup history survives teardown. If you really need to nuke it, remove the guard via `terraform state rm module.staging.digitalocean_spaces_bucket.staging_backups` AFTER taking a manual backup.
- The Reserved IP is managed out-of-band; `terraform destroy` only removes the assignment, not the IP itself. Release it in the DO UI if you want to stop paying for it (~4 USD/mo idle).
- Re-provision later is `terraform apply` + secret seeding again. Seeding from scratch is fine — staging data is synthetic.

---

## Cost (April 2026 rates)

| Resource | Spec | Est monthly |
|---|---|---|
| DO Droplet | s-2vcpu-4gb | ~24 USD |
| DO Spaces | 250GB + egress | ~5 USD |
| DO Reserved IP | attached (free) / unattached (~4 USD) | 0-4 USD |
| Monitoring (DO built-in) | free | 0 |
| **Total (active)** | | **~29 USD/mo** |
| **Total (torn-down, IP reserved)** | | **~5 USD/mo** |

Recommended cap: set `DO_MONTHLY_BUDGET_ALERT=50` in the DO billing alerts. Anything above that means something is wrong (runaway backups, droplet upgraded without review).

---

## Divergence tracking

If staging and prod ever genuinely need different service shape (e.g. staging runs a mock payment service), add the service to `docker-compose.staging.yml` (not the base). Also create `infrastructure/deploy/service-criticality.staging.yaml` and `required-signals.staging.yaml`, and point the workflow at them via `MANIFEST=`. Do NOT fork the base compose.

Until that day, the staging runbook reuses the prod criticality + signals manifests by path — same SSoT, zero drift risk.

---

## Troubleshooting

| Symptom | First check |
|---|---|
| Staging deploy fails at "pre-flight: required secrets" | Something in `.env` missing — cross-reference `required-secrets.yaml` |
| Staging deploy fails at "WS6 criticality gate" | `docker compose logs <service>` for the failing service |
| Staging deploy fails at "WS7 boot-signal gate" | Service booted but skipped NATS mTLS / schema drift / migration — check the specific missing signal in the workflow output |
| Prod gate never passes | `deployed/staging-<sha>` tag missing — staging deploy never finished. Open the staging workflow for the same SHA |
| Prod gate passed but deploy fails | Unrelated to staging gate. Normal prod deploy investigation |
| Image pull fails (`denied`) | Check `ghcr.io` login in the workflow + GitHub PAT for packages:read |
| DNS propagation slow | 300s TTL — wait 5 min; if the A record never resolves, check `terraform output dns_record_fqdn` and DO DNS dashboard |

---

## Ownership

| Area | Owner |
|---|---|
| Runbook content | platform-ops |
| Terraform module | infra-expert (reviewed by security-reviewer for firewall rules) |
| Staging secret rotation | follows `docs/runbooks/secret-rotation.md` — cadence identical to prod |
| Bypass approvals | on-call incident commander |

Last review: 2026-04-14 (WS9 Phase 1 landed).
