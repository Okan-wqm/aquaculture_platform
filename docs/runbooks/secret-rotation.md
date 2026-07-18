# Runbook: Secret Rotation

Procedures for rotating security-critical secrets in the aquaculture platform. All rotations are zero-downtime when followed in order.

## Stripe webhook signing secret (`STRIPE_WEBHOOK_SECRET`)

Consumed by `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:74`. Rotated via Stripe's built-in rolling keys feature so no inbound events are dropped during transition.

**Prerequisites:** Stripe Dashboard admin access, deploy access to billing-service, Slack channel for ops coordination.

**Steps:**

1. **Create a new signing secret in Stripe Dashboard**:
   - Developers → Webhooks → select your endpoint → "Roll signing secret"
   - Stripe activates the new key AND retains the old key for a configurable overlap window (default 24h).
   - Both secrets accept incoming events during overlap — no drop window.

2. **Stage the new secret**:
   - Docker Compose deploys: update `STRIPE_WEBHOOK_SECRET` in your `.env` / Docker secret store.
   - Kubernetes deploys: update the source secret (External Secrets Operator / Sealed Secrets).
   - CI/CD: update the pipeline's secret variable.

3. **Roll billing-service replicas**:
   - `docker compose up -d billing-service` (picks up new env).
   - `kubectl rollout restart deployment/aquaculture-billing-service`.
   - Verify: `docker logs aqua-billing | grep "STRIPE_WEBHOOK_SECRET"` shows NO `not configured` warning.

4. **Trigger a test event** from Stripe dashboard (Developers → Webhooks → your endpoint → "Send test webhook"). Confirm 200 response in Stripe's delivery log.

5. **Mark the old secret revoked** in Stripe dashboard (optional — happens automatically after overlap window expires). Keeps audit clean.

**Rollback**: if a post-roll endpoint rejects valid events, re-deploy with the previous `STRIPE_WEBHOOK_SECRET` value (Stripe still accepts old secret during overlap). Root-cause the verification failure before retrying.

## Stripe server-side API key (`STRIPE_SECRET_KEY`)

Consumed by billing-service's Stripe client for outbound API calls (checkout, subscription, refunds). The **canonical env var name is `STRIPE_SECRET_KEY`** — it is the single source of truth read by the client factory at `libs/backend-common/src/billing/stripe-client.factory.ts` (`STRIPE_SECRET_KEY_ENV = 'STRIPE_SECRET_KEY'`). Use **restricted keys** in production — never the full-access secret key.

> **Historical name drift — do NOT use `STRIPE_API_KEY`.** Earlier compose/Helm manifests injected the outbound key as `STRIPE_API_KEY`, a name the factory never reads. Because the factory keys off `STRIPE_SECRET_KEY`, injecting `STRIPE_API_KEY` silently leaves Stripe **unconfigurable** — this env-name fracture contributed to the 2026-06 Suderra billing outage (see `docs/reviews/orphan-findings.md`, the 2026-06-27 runtime correction). Always stage the outbound key under `STRIPE_SECRET_KEY`; grep deploy manifests for stray `STRIPE_API_KEY` and migrate them.

**Steps:**

1. Stripe Dashboard → Developers → API keys → "Create restricted key".
2. Grant only the resources billing-service actually uses: Customers (write), Subscriptions (write), Invoices (read), Checkout Sessions (write), Webhook Endpoints (read). Deny everything else.
3. Stage as `STRIPE_SECRET_KEY` in the same secret store as the webhook secret (step 2 above). Roll billing-service.
4. Verify by creating a subscription in staging — expect 200 from Stripe. Check billing logs for `Stripe API call succeeded`.
5. Revoke the old key in Stripe dashboard after staging verification — no overlap needed for API keys (no signature verification latency).

**Rollback**: re-stage previous key and roll. Stripe retains old key in an audit log; re-create if needed from the dashboard (you cannot recover the raw value once shown).

## JWT signing keys (RS256 keypair)

Consumed by auth-service (issuer) and every other backend service (verifier). See `infrastructure/docker/scripts/generate-jwt-keypair.sh`.

Rotation is more involved (all services need the new public key before auth-service starts issuing with the new private key). Documented separately in a future runbook when rotation is planned.

## Password pepper (`PASSWORD_PEPPER`)

Consumed by auth-service to HMAC passwords before bcrypt. Rotation requires re-hashing all existing user passwords. NOT a routine rotation — only performed after a suspected pepper leak. Separate incident-response runbook covers this.

**Initial generation (new droplet).** Happens automatically: `droplet-up.sh` Phase A4 invokes `scripts/deploy/droplet-bootstrap-env.sh` on every deploy. The generator is idempotent — it greps for each required secret's `^NAME=` line and skips any that are already present, so it amortises to "runs once per droplet's lifetime" in practice. A pre-existing `PASSWORD_PEPPER` is never overwritten: this path only generates if absent, never rotates. Manual invocation with `sudo bash scripts/deploy/droplet-bootstrap-env.sh` is still available for disaster-recovery / onboarding scenarios but is not required for routine deploys.

**Rotation is a separate, deliberate operation.** Rotating `PASSWORD_PEPPER` invalidates every stored bcrypt hash and requires a platform-wide forced password reset — reserved for compromise response, never scheduled. The bootstrap generator deliberately has no "rotate" mode; rotation is performed by removing the line from `.env` under incident-response supervision, letting bootstrap regenerate, and then running the forced-reset migration.

## Database passwords (per-service)

Defined in `infrastructure/docker/init-scripts/00-init-schemas.sh`. Rotated via:

1. Update service-specific password env var (e.g. `BILLING_SERVICE_DB_PASS`).
2. `ALTER ROLE billing_service WITH PASSWORD '<new>'` on the running DB.
3. Roll the service that uses that role.

Can be done one role at a time without cross-service impact because each service has its own role.

## DigitalOcean Spaces principals (backup and DR)

`.github/manifests/backup-secrets.json` defines exactly 25 required secrets,
four required non-secret variables, and separate principals in the
`production-backup` GitHub Environment. Never
replace them with a shared `SPACES_ACCESS_KEY_ID` /
`SPACES_SECRET_ACCESS_KEY` pair:

| Principal          | Environment secrets                                                                      | Proof before revoking the old key                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| WAL-G runtime      | `WALG_SPACES_ACCESS_KEY_ID`, `WALG_SPACES_SECRET_ACCESS_KEY`                             | non-dry full backup, WAL verification, and protected timestamp PITR                                                                  |
| PITR read-only     | `PITR_WALG_SPACES_ACCESS_KEY_ID`, `PITR_WALG_SPACES_SECRET_ACCESS_KEY`                   | isolated target fetch with no source-bundle mutation and a successful protected timestamp PITR                                       |
| Logical backup     | `LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID`, `LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY`         | new client-encrypted `.dump.gpg`, reciprocal verification sidecar, `ContentLength` / `Metadata.sha256`, and isolated logical restore |
| Evidence publisher | `EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID`, `EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY` | signed backup/PITR GitHub Actions artifact and byte-identical versioned mirror record                                                |
| Evidence verifier  | `EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID`, `EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY`   | successful `verify-backup-dr-closure.yml` integrity run with read-only mirror access                                                 |

Do not omit the control values that bind transport and storage coordinates:

| Environment secret             | Rotation/configuration rule                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `DROPLET_SSH_FINGERPRINT`      | Obtain the canonical SHA256 host-key fingerprint out of band; change it only for an authorized host-key rotation.                 |
| `SPACES_REGION`                | Supply the explicit Spaces signing region to every AWS CLI and WAL-G process; change it only with an authorized region migration. |
| `LOGICAL_BACKUP_GPG_RECIPIENT` | Pin the independently escrowed GPG public-key fingerprint used for mandatory client-side logical-dump encryption.                 |

The Environment variables `WALG_SPACES_BUCKET`, `WALG_BACKUP_EPOCH`,
`PITR_WALG_SPACES_BUCKET`, and `PITR_WALG_BACKUP_EPOCH` are not credentials,
but they are mandatory authority coordinates. The write and PITR tuples must
name the same active epoch for a current-timestamp drill; the PITR credentials
remain a separate read-only principal.

For any principal, create the replacement bucket-scoped key, update only its
two Environment secrets, run its proof, then revoke the old key. Keep the
other four principals unchanged. `SPACES_ENDPOINT`, `SPACES_REGION`,
`LOGICAL_BACKUP_SPACES_BUCKET`, and `EVIDENCE_SPACES_BUCKET` are location
configuration, not reusable credentials.

The backup, PITR, and freshness workflows use the runner's native system
OpenSSH client and accept exactly one advertised host key matching the
protected `DROPLET_SSH_FINGERPRINT`. Do not replace this with a downloaded SSH
action, `accept-new`, or an unprotected `ssh-keyscan` result.

The operation-specific broker keys declared in
`.github/manifests/backup-ssh-broker-policy.json` are a staged authority and
must remain distinct. While `cutover.enabled` is `false`, they authorize only
the attestation workflow; current backup runtime names remain unchanged. Build
and install the signed static broker first, then rotate
`BACKUP_BROKER_SSH_KEY`, `PITR_BROKER_SSH_KEY`, and
`WAL_FRESHNESS_BROKER_SSH_KEY` one at a time with a new Ed25519 key, an updated
pairwise-distinct fingerprint variable, and a successful operation-specific
attestation. Never copy the deploy key or the legacy shared backup key into a
broker secret, and never introduce a legacy fallback during cutover.

`dry_run: true` skips object upload and cannot prove an object-storage
rotation. The real backup proof uses `dry_run: false`. The logical object under
`pg-backups/YYYY/MM/DD/` must be a client-encrypted `.dump.gpg` produced for
`LOGICAL_BACKUP_GPG_RECIPIENT`, have the expected `ContentLength` and
`Metadata.sha256`, and have a reciprocal client-encrypted
`.verification.json.gpg` binding that restores successfully. DigitalOcean
Spaces SSE-S3 is unsupported by this
contract and is not configured, asserted, or relied on; it cannot replace GPG
encryption before upload.

GitHub Actions identity and a Cosign/Rekor bundle prove which workflow signed
the host-authored JSON, while the versioned `EVIDENCE_SPACES_BUCKET` proves
mirror parity. They do not independently attest that the host's backup or
restore claims are true. This blind-notary construction is not DR closure
authority. `INFRA-CRITICAL-040` keeps production closure blocked until a
separately trusted DR executor and independent object authority observe and
attest the ceremony outside the production-host trust boundary. Target-only
PITR counts and checksums likewise do not prove source application parity;
`INFRA-HIGH-051` remains open.

## Logical-backup GPG recipient (`LOGICAL_BACKUP_GPG_RECIPIENT`)

This Environment value is the full fingerprint of the public key installed in
the production backup keyring. Its matching private key is independently
escrowed and is loaded only on an isolated restore host. Every non-dry logical
backup must fail closed unless the recipient is an exact 40-hex primary-key
fingerprint resolving to one public key and `gpg` is available. Plaintext dump
or verification-sidecar objects must never be uploaded. The isolated restore
must similarly prove one exact matching primary secret-key fingerprint before
decrypting either envelope.

Rotate the keypair as an encryption epoch:

1. Generate the replacement keypair in the approved offline key-management
   environment and escrow both its fingerprint and private recovery material.
2. Import only the public key on the production droplet and verify its full
   fingerprint out of band.
3. Update `LOGICAL_BACKUP_GPG_RECIPIENT`, run a non-dry backup, and require a
   new `.dump.gpg` object plus reciprocal verification sidecar.
4. On an isolated drill host, decrypt and restore that exact object with the
   new private key and complete the snapshot-bound parity checks.
5. Retain every old private key for at least the lifetime of objects encrypted
   to it; never revoke or delete recovery material merely because a new epoch
   succeeds.

## WAL-G client-encryption key (`WALG_LIBSODIUM_KEY_B64`)

This protected Environment secret materializes as canonical base64 text in a
mode-`0600` file under `/run/aqua-walg-secrets` tmpfs. It is never a Compose
credential value and never appears beneath PGDATA. Treat a rotation as a
recovery-chain epoch transition, not an in-place overwrite:

1. Prove the current epoch with WAL verification, record its explicit latest
   full backup, prefix, and key identifier, and confirm the old key is in
   offline escrow.
2. Generate a new 32-byte key in the approved secret manager, choose a new
   `WALG_BACKUP_EPOCH`, and verify the derived
   `s3://<WALG_SPACES_BUCKET>/postgres/wal-g/<WALG_BACKUP_EPOCH>` prefix is
   empty. Never reuse an epoch prefix with a different key.
3. In one controlled window, update the write key/epoch and the matching
   `PITR_WALG_LIBSODIUM_KEY_B64`, `PITR_WALG_SPACES_BUCKET`, and
   `PITR_WALG_BACKUP_EPOCH` restore tuple; update the droplet epoch, materialize
   the source bundle, and recreate PostgreSQL with the derived image.
   Investigate any archive backlog before proceeding. The PITR workflow builds
   only a run-scoped target bundle and must not mutate the live source bundle.
4. Produce a full backup, three consecutive signed integrity records, and one
   timestamp PITR record. Run the read-only verifier, but do not treat these
   host-authored records as closing `INFRA-CRITICAL-040`.
5. Keep the old prefix and key escrowed for at least the complete retention
   period. An old restore requires its matching prefix/key pair.

On suspected key disclosure, lock production deploys, stop granting new reads
to the affected prefix, preserve ciphertext for forensics/retention, and start
a new epoch. Never paste either key into a ticket or log.

## WAL-G runtime-path contract (`INFRA-HIGH-056`)

WAL-G v3.0.8 does not preserve arbitrary PostgreSQL PGDATA symlink targets: a
source `wal-g-secrets -> /run/aqua-walg-secrets` link restores as
`wal-g-secrets -> /wal-g-secrets`. Credential rotation must therefore never
create or depend on a PGDATA symlink.

- `WALG_SECRET_DIR` must resolve directly to `/run/aqua-walg-secrets`.
- The loader may copy the verified bundle only into tmpfs and must leave
  `PGDATA/wal-g-secrets` absent.
- Backup preflight and post-fetch validation must reject unexpected PGDATA
  symlinks without following or repairing them.
- Existing backups containing the legacy or rewritten link cannot qualify for
  closure; produce a fresh full-backup sequence after the direct-tmpfs contract
  is deployed.

Rotating the WAL-G key or Spaces principal does not relax this invariant.

## PITR source system identifier

`PITR_SOURCE_SYSTEM_IDENTIFIER` pins restore ceremonies to the intended source
cluster. It is not cadence-rotated. Update it only after an authorized source
cluster reinitialization using a trusted production query to
`pg_control_system()`, then repeat the backup/PITR integrity ceremony. Never
derive the expected value from the restore target.

## Audit trail

Every rotation triggers a WARN log entry via the standard logging middleware. Grep production logs for `secret.rotated` to confirm the deploy picked up the new value. Consider adding a Grafana alert on absence of this entry after a scheduled rotation window.

## Sensor credential-vault key (`CREDENTIAL_ENCRYPTION_KEY`)

The AES-256-GCM key that encrypts sensor-service device credentials at rest via
`CredentialVaultService` (`apps/sensor-service/src/infrastructure/vault`). It
protects, in `enc:<iv>:<authTag>:<ciphertext>` form:

- `lora_devices.app_key` — LoRaWAN OTAA root keys (SENSOR-MEDIUM-044).
- `sensors.protocol_configuration` secret-named fields — MQTT/AMQP/OPC-UA
  passwords, API keys, OAuth2 secrets, CoAP PSKs (SENSOR-MEDIUM-080), field-level
  (non-secret fields such as `host`/`topic` stay plaintext).
- `plc_connections` credential columns.

**Format has no key-version tag**, so a live dual-key overlap is not possible —
rotation is a scheduled re-encryption, NOT zero-downtime. Do it under
change-management with a maintenance window.

**Steps:**

1. **Back up** the affected tables (or take a full DB backup) and verify restore
   on a staging copy before touching production.
2. **Stage BOTH keys**: keep the current `CREDENTIAL_ENCRYPTION_KEY` as
   `CREDENTIAL_ENCRYPTION_KEY_OLD` (read side) and set the new 32-byte key as
   `CREDENTIAL_ENCRYPTION_KEY`.
3. **Re-encrypt** every affected column with an app-aware migration that decrypts
   each value with the OLD key and re-encrypts with the NEW key — the same
   per-schema fan-out + `credential-crypto` helpers the backfill migrations
   `1811*`/`1812*` use (`decryptSecretValue(value, OLD)` →
   `encryptSecretValue(clear, NEW)`). SQL cannot decrypt; the update expression
   MUST be the cipher-aware script.
4. **Roll sensor-service** replicas so the running vault loads the new key; the
   transformer then reads/writes exclusively under it.
5. **Verify**: sample 1% of `lora_devices` / `sensors` rows decrypt successfully
   via the new key (a failed decrypt surfaces as `[DECRYPTION_FAILED]` in reads).
6. **Destroy `CREDENTIAL_ENCRYPTION_KEY_OLD`** after the retention window and
   archive the pre-rotation backup per the retention matrix.

**Rollback**: if step 4 reads report `[DECRYPTION_FAILED]`, redeploy with the OLD
key as `CREDENTIAL_ENCRYPTION_KEY` and root-cause before retrying — the old
ciphertext is unchanged until the re-encryption migration commits.

## Rotation cadence

Closes `docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-ROTATION-001`. Without an explicit cadence, secrets drift toward "rotate never" by default. The cadence below is the baseline; an observed compromise or suspected leak collapses the interval to "now" and triggers the incident-response runbook instead.

| Secret                                                       | Rotation interval                                | Reminder lead time | Owner               | Procedure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY` (RS256 keypair)         | 90 days                                          | 14 days            | auth-service oncall | §"JWT signing keys" once the zero-downtime rollout runbook is written; until then, treat as an annual planned outage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `STRIPE_WEBHOOK_SECRET`                                      | 90 days                                          | 14 days            | billing oncall      | §"Stripe webhook signing secret"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `STRIPE_SECRET_KEY` (restricted)                             | 90 days                                          | 14 days            | billing oncall      | §"Stripe server-side API key"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Per-service DB passwords                                     | 90 days                                          | 14 days            | data oncall         | §"Database passwords (per-service)"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PASSWORD_PEPPER`                                            | 180 days (or on incident)                        | 30 days            | auth-service oncall | §"Password pepper" (incident-response only outside cadence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `REDIS_PASSWORD`                                             | 180 days                                         | 30 days            | infra oncall        | roll via droplet env + `docker compose up -d redis`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CREDENTIAL_ENCRYPTION_KEY` (sensor at-rest)                 | 180 days (or on incident)                        | 30 days            | sensor-service oncall | §"Sensor credential-vault key" — scheduled re-encryption via `credential-crypto`; NOT zero-downtime (no key-version tag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| NATS mTLS client certs                                       | 12 months                                        | 30 days            | infra oncall        | `scripts/generate-internal-certs.sh` regenerates in lockstep with `infrastructure/nats/services.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Droplet SSH host key/fingerprint                             | on authorized host-key change or compromise      | n/a                | infra oncall        | obtain the new fingerprint out of band → update `DROPLET_SSH_FINGERPRINT` → require native OpenSSH exact-match preflight before any remote command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Backup broker operation SSH keys                             | 90 days or immediately on suspected disclosure   | 14 days            | infra oncall        | while pre-cutover, rotate only the matching broker key/fingerprint → install its public key through the root-owned provisioner → pass that account's attestation and cross-key denial matrix; after cutover, repeat the operation proof before revoking the old key                                                                                                                                                                                                                                                                                                                                                                                |
| WAL-G Spaces principal                                       | 90 days                                          | 14 days            | infra oncall        | rotate `WALG_SPACES_ACCESS_KEY_ID` / `WALG_SPACES_SECRET_ACCESS_KEY` → non-dry full backup + WAL verification + timestamp PITR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PITR read-only Spaces principal                              | 90 days                                          | 14 days            | infra oncall        | rotate `PITR_WALG_SPACES_ACCESS_KEY_ID` / `PITR_WALG_SPACES_SECRET_ACCESS_KEY` → isolated target fetch succeeds while the live source bundle digest remains unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Logical-backup Spaces principal                              | 90 days                                          | 14 days            | infra oncall        | rotate `LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID` / `LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY` → run with `dry_run: false` → verify encrypted `.dump.gpg`, `ContentLength` + `Metadata.sha256` + reciprocal sidecar → decrypt and restore exact object                                                                                                                                                                                                                                                                                                                                                                                                   |
| Evidence-publisher Spaces principal                          | 90 days                                          | 14 days            | infra oncall        | rotate `EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID` / `EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY` → signed Actions artifact + versioned content-addressed mirror parity                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Evidence-verifier Spaces principal                           | 90 days                                          | 14 days            | infra oncall        | rotate `EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID` / `EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY` → read-only `verify-backup-dr-closure.yml` integrity success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| WAL-G client-encryption key                                  | 12 months or immediately on suspected disclosure | 30 days            | infra oncall        | create a new prefix/key epoch → preserve old prefix/key escrow → full base backup → three-success + timestamp-PITR integrity proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Logical-backup GPG keypair                                   | 12 months or immediately on suspected disclosure | 30 days            | infra oncall        | rotate `LOGICAL_BACKUP_GPG_RECIPIENT` as a new encryption epoch → retain old private-key escrow → upload `.dump.gpg` → decrypt and restore the exact object on an isolated host                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RDS Proxy IAM auth token (only when `enable_rds_proxy=true`) | 12 hours (auto, AWS-managed)                     | n/a                | infra oncall        | AWS rotates IAM auth tokens automatically every 15 min while the proxy is active. There is NO operator-run rotation for the auth token itself; the rotation knob is the **DB master credentials secret** (above) which the proxy reads via its IAM role. Operator action required only on a suspected proxy IAM role compromise — recreate the role via Terraform (`module.rds_proxy.iam_role_arn`) and run `aws rds reboot-db-proxy --db-proxy-name <name>`. Reference: `infrastructure/terraform/modules/rds-proxy/main.tf` (the role's `secretsmanager:GetSecretValue` policy is scoped to the exact secret ARN — no wildcard rotation needed). |
| Plan ARIA `aria-ack-hmac-key` (operator-local)               | 90 days                                          | 14 days            | aria oncall         | Operator-local HMAC key at `aria-tools/secrets/ack_hmac.key` signing the autonomous-loop ack ledger. NEVER committed to git. Rotation via `aria-kernel ack rotate-key --reason ... --operator-approval-ref ...`; full procedure in [aria-ack-key-rotation.md](aria-ack-key-rotation.md).                                                                                                                                                                                                                                                                                                                                                           |

**Reminders:** `.github/workflows/secret-rotation-reminder.yml` opens a GitHub issue `Rotation due: <secret>` during the lead-time window. The issue is assigned to the owner team listed above; closing the issue without rotating the secret requires a comment explaining the deferral, its new due date, and the mitigating control.

**Rotation postponements are capped at one cadence interval.** A JWT keypair cannot be postponed twice in a row; the second postponement auto-escalates to the CTO as a CRITICAL finding under INFRA-ROTATION-001.
