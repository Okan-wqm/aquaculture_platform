# Database Restore Drill

## Protected backup environment

Backup, archive-freshness, PITR, evidence publication, and closure verification
resolve credentials from the `production-backup` GitHub Environment. Generic
repository secrets are not part of this trust boundary. Create the Environment
before seeding credentials:

1. Go to `Settings -> Environments -> New environment`.
2. Name it `production-backup`.
3. Restrict deployment branches to `main`.
4. Do not configure a wait timer or reviewers on this shared Environment. The
   scheduled backup and five-minute freshness probe must run unattended.
5. Add the credential values below under
   `Settings -> Environments -> production-backup -> Environment secrets`.
6. Add the non-secret epoch coordinates in the following variables table under
   the same Environment's **Variables** section.

| Secret                                        | Profiles                                                                    | Purpose                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DROPLET_HOST`                                | `backup-runtime`, `pitr-runtime`, `archive-freshness`                       | Production droplet host                                                                         |
| `DROPLET_USER`                                | `backup-runtime`, `pitr-runtime`, `archive-freshness`                       | Restricted SSH operator                                                                         |
| `DROPLET_SSH_KEY`                             | `backup-runtime`, `pitr-runtime`, `archive-freshness`                       | Private key for that operator                                                                   |
| `DROPLET_SSH_FINGERPRINT`                     | `backup-runtime`, `pitr-runtime`, `archive-freshness`                       | Protected SHA256 fingerprint of the production SSH host key                                     |
| `SPACES_ENDPOINT`                             | `backup-runtime`, `pitr-runtime`, `evidence-publisher`, `evidence-verifier` | Regional S3-compatible endpoint; not a credential                                               |
| `SPACES_REGION`                               | `backup-runtime`, `pitr-runtime`, `evidence-publisher`, `evidence-verifier` | Explicit signing region for every AWS CLI and WAL-G operation                                   |
| `PITR_SOURCE_SYSTEM_IDENTIFIER`               | `pitr-runtime`                                                              | Protected expected `pg_control_system().system_identifier` value for source-cluster attestation |
| `WALG_SPACES_ACCESS_KEY_ID`                   | `backup-runtime`                                                            | Write key id dedicated to WAL archive/base-backup storage                                       |
| `WALG_SPACES_SECRET_ACCESS_KEY`               | `backup-runtime`                                                            | Secret for the WAL-G write key id                                                               |
| `PITR_WALG_SPACES_ACCESS_KEY_ID`              | `pitr-runtime`                                                              | Read-only key id for the isolated PITR target                                                   |
| `PITR_WALG_SPACES_SECRET_ACCESS_KEY`          | `pitr-runtime`                                                              | Secret for the read-only PITR key id                                                            |
| `LOGICAL_BACKUP_SPACES_BUCKET`                | `backup-runtime`                                                            | Bucket dedicated to logical dumps and verification sidecars                                     |
| `LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID`         | `backup-runtime`                                                            | Logical-backup bucket key id                                                                    |
| `LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY`     | `backup-runtime`                                                            | Logical-backup bucket secret                                                                    |
| `LOGICAL_BACKUP_GPG_RECIPIENT`                | `backup-runtime`                                                            | Fingerprint of the independently escrowed public key for client-side dump encryption            |
| `EVIDENCE_SPACES_BUCKET`                      | `evidence-publisher`, `evidence-verifier`                                   | Versioned content-addressed mirror for signed integrity records                                 |
| `EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID`     | `evidence-publisher`                                                        | GitHub runner key id with write access to the evidence mirror                                   |
| `EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY` | `evidence-publisher`                                                        | Secret for the evidence-publisher key id                                                        |
| `EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID`      | `evidence-verifier`                                                         | Read-only evidence-mirror key id                                                                |
| `EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY`  | `evidence-verifier`                                                         | Secret for the read-only verifier key id                                                        |
| `BACKUP_POSTGRES_USER`                        | `backup-runtime`, `pitr-runtime`                                            | PostgreSQL role used by protected backup/restore commands                                       |
| `BACKUP_POSTGRES_DB`                          | `backup-runtime`, `pitr-runtime`                                            | Production database name                                                                        |
| `BACKUP_POSTGRES_PASSWORD`                    | `backup-runtime`, `pitr-runtime`                                            | Password passed only to the protected remote process                                            |
| `WALG_LIBSODIUM_KEY_B64`                      | `backup-runtime`                                                            | Canonical base64 text for the active 32-byte WAL-G encryption key                               |
| `PITR_WALG_LIBSODIUM_KEY_B64`                 | `pitr-runtime`                                                              | Independently supplied decryption key for the isolated target epoch                             |

| Environment variable      | Profiles         | Purpose                                                       |
| ------------------------- | ---------------- | ------------------------------------------------------------- |
| `WALG_SPACES_BUCKET`      | `backup-runtime` | Active WAL-G write bucket                                     |
| `WALG_BACKUP_EPOCH`       | `backup-runtime` | Active key/prefix epoch slug                                  |
| `PITR_WALG_SPACES_BUCKET` | `pitr-runtime`   | Bucket selected for the isolated read-only restore target     |
| `PITR_WALG_BACKUP_EPOCH`  | `pitr-runtime`   | Epoch selected for the isolated target-only credential bundle |

The source of truth is `.github/manifests/backup-secrets.json`. Its five
least-privilege profiles are:

| Profile              | Used by                                            | Storage authority                                    |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `backup-runtime`     | full WAL-G backup plus snapshot-bound logical dump | WAL-G and logical-backup principals only             |
| `pitr-runtime`       | protected isolated restore                         | WAL-G read path only                                 |
| `evidence-publisher` | OIDC signing jobs in backup/PITR workflows         | read/write operational access to the evidence mirror |
| `evidence-verifier`  | enterprise integrity workflow                      | read-only evidence-mirror access                     |
| `archive-freshness`  | five-minute PostgreSQL health probe                | none                                                 |

The workflow preflights, runtime mappings, and this runbook must stay in
lockstep with that manifest. Do not reuse a key between WAL-G, logical backup,
evidence publication, and evidence verification.

### Protected SSH broker substrate (pre-cutover)

`INFRA-CRITICAL-044` remains open because OpenSSH invokes a target account's
login shell before the current stdin payload. A client-side fixed command does
not remove that startup boundary. The staged replacement is declared in
`.github/manifests/backup-ssh-broker-policy.json` and is deliberately
attestation-only while `cutover.enabled` is `false`:

- `aqua-backup`, `aqua-pitr`, and `aqua-wal-freshness` are separate system
  accounts whose invalid `NP` password sentinel disables password use without
  making the accounts invalid for public-key authentication;
- their actual login shell is the root-owned static ELF
  `/usr/local/sbin/aqua-protected-ssh-broker`, never Bash, Dash, Python, or a
  user-writable wrapper;
- each account has one public, root-owned, non-writable authorized-key file
  forced to exactly one public command: `aqua-backup-v1`, `aqua-pitr-v1`, or
  `aqua-wal-freshness-v1`;
- the broker accepts only sshd's exact `-c <command>` argv, requires the same
  byte sequence in `SSH_ORIGINAL_COMMAND`, rejects terminal input, and emits a
  single digest-bound JSON attestation; and
- this substrate executes no backup, PITR, Docker, sudo, or stdin payload.

Build the broker only from protected merged `main` with
`backup-ssh-broker-release.yml`. Its OIDC signing job is separately gated by
the main-only `production-backup-release` Environment. Administrator bypass
must be disabled, self-review prevention enabled, and at least two eligible
reviewers configured before it can sign. The job proves the merged PR, exact
protected-main merge SHA, PR-head SHA, pinned required-check policy, and
successful pre-merge required check-run IDs before signing. Preserve the immutable
artifact ID/digest, release run ID/attempt, OIDC bundles, build provenance,
release-authority record, source SHA-256, and architecture-specific binary
SHA-256. Install the verified artifact through the provider console or an
independently administered bastion, never through the legacy secret-bearing
SSH path. Extract that exact artifact into a root-owned, non-writable directory;
run its bundled provisioner rather than a mutable checkout copy:

```bash
RELEASE_ROOT='/root/aqua-protected-ssh-release-<artifact-id>'
sudo env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  BROKER_BINARY_PATH="${RELEASE_ROOT}/aqua-protected-ssh-broker" \
  EXPECTED_BROKER_SHA256='<signed artifact binary sha256>' \
  BACKUP_PUBLIC_KEY_PATH=/root/aqua-backup.pub \
  PITR_PUBLIC_KEY_PATH=/root/aqua-pitr.pub \
  WAL_FRESHNESS_PUBLIC_KEY_PATH=/root/aqua-wal-freshness.pub \
  /bin/bash -p \
    "${RELEASE_ROOT}/repository/infrastructure/scripts/provision-backup-ssh-broker.sh"
```

The provisioner first reloads a reserved `DenyUsers` maintenance drop-in for
all three protected principals. Only after that connection barrier is active
does it replace broker, account, key, or permanent sshd policy state. It
removes the maintenance file after validating the complete candidate, and the
second reload activates that candidate as one unit. Any failure before the
second reload restores the original files and account state while the running
daemon still denies new protected-account connections, then reloads the
restored configuration.

The three public keys must be newly generated Ed25519 keys with pairwise
distinct SHA256 fingerprints. After the provisioner validates and reloads
sshd, add these pre-cutover credentials to the protected `production-backup`
Environment without deleting the legacy names:

| Type     | Name                                       |
| -------- | ------------------------------------------ |
| Secret   | `BACKUP_BROKER_SSH_KEY`                    |
| Secret   | `PITR_BROKER_SSH_KEY`                      |
| Secret   | `WAL_FRESHNESS_BROKER_SSH_KEY`             |
| Variable | `BACKUP_BROKER_SSH_KEY_FINGERPRINT`        |
| Variable | `PITR_BROKER_SSH_KEY_FINGERPRINT`          |
| Variable | `WAL_FRESHNESS_BROKER_SSH_KEY_FINGERPRINT` |

Run `verify-backup-ssh-broker.yml` from exact merged `main` with the signed
release's run ID, artifact ID, and `sha256:<digest>` as explicit inputs. The
workflow must derive expected source and binary digests only from the verified
signed provenance, never mutable Environment variables. Preserve all three
successful diagonal attestations and the live off-diagonal key/account,
arbitrary-command, interactive-shell, subsystem, PTY, remote-forward, and
direct-stream denial matrix. Separately capture provider-console `sshd -T`
output plus file ownership/modes to prove user environment and user rc remain
disabled. Host self-attestation alone is not independent evidence; compare it
with the signed release and that externally observed sshd configuration and
file ownership.

Do not point backup, PITR, or freshness at the broker in this substrate phase.
The atomic cutover requires a later reviewed change with a strict bounded data
protocol and fixed operation executors; it must contain no fallback to
`DROPLET_SSH_KEY` and must restart the three-success evidence sequence. Do not
seed executable secret payloads into this attestation-only broker.

`WALG_LIBSODIUM_KEY_B64` and its PITR counterpart must come from an approved
secret manager. Keep an offline escrow copy indexed by bucket, epoch, and
activation date. Never put
the encoded or decoded value in Git, `.env`, Compose environment metadata,
workflow logs, tickets, or the drill log. Losing the key makes its backup/WAL
epoch unrecoverable.

Every uploaded logical dump and its tenant-bearing verification sidecar must be
encrypted independently on the production host with GPG for the exact 40-hex
`LOGICAL_BACKUP_GPG_RECIPIENT` primary-key fingerprint before any bytes leave
the host. Only `.dump.gpg` and `.verification.json.gpg` objects may be uploaded;
plaintext payloads may exist only in the script's private run-scoped directory
and must be deleted by its cleanup path. The corresponding decryption key must
be independently escrowed and must never be copied to production. DigitalOcean
Spaces SSE-S3 is not supported by this backup contract and is neither
configured nor accepted as a substitute for mandatory client-side encryption.

Set `PITR_SOURCE_SYSTEM_IDENTIFIER` from a trusted production session using
`SELECT system_identifier FROM pg_control_system();`. Do not obtain it from a
restore target or workflow output. Change it only after an authorized source
cluster reinitialization and repeat the complete integrity ceremony.

To remediate a missing-secret incident, a dry run is not enough. Complete the
bootstrap, three full backups, protected PITR, integrity verification, and
logical companion restore below. Record workflow URLs, run/attempt ids,
artifact names, object identifiers, hashes, timings, and operators. Never
record credential values.

## Evidence authority

GitHub Actions artifacts and their Cosign/Rekor bundles authenticate which
workflow signed a particular byte sequence. The versioned,
content-addressed DigitalOcean Spaces mirror can prove byte-for-byte parity
with that sequence. Neither mechanism independently proves the truth of the
host-authored JSON: the production host supplies the backup and PITR claims,
and GitHub currently signs the bytes it receives from that same trust domain.
This is a blind-notary construction. The GitHub artifact, signature, and
mirror are integrity and audit signals, not DR closure authority.

`INFRA-CRITICAL-040` remains open and production closure remains blocked. It
may be reconsidered only after a separately trusted DR executor performs and
observes the recovery ceremony outside the production-host trust boundary and
an independent object authority attests the selected backup/WAL objects and
restore result. Adding another signature to host-authored JSON, or copying it
to another bucket, does not satisfy this requirement.

- Backup artifact:
  `walg-evidence-v2-backup-production.yml-<run_id>-<run_attempt>`.
- PITR artifact:
  `walg-evidence-v2-pitr-restore-production.yml-<run_id>-<run_attempt>`.
- Every artifact contains `run-record.json` and
  `run-record.sigstore.json`. A successful record-producing run also contains
  `evidence-attestation.json` and `evidence-attestation.sigstore.json`.
- The signer identity is the exact workflow file at `refs/heads/main`, issued
  by `https://token.actions.githubusercontent.com`. Verification binds the
  repository, workflow name/ref/SHA, trigger, run id, and run attempt to the
  live GitHub API record.
- Mirror keys are content addressed as
  `wal-g-evidence/v2/sha256/<record-sha256>/<record-name>`. Bucket versioning
  must be enabled. Mirror metadata or unsigned JSON is not evidence.

Verify and preserve all qualifying GitHub Actions artifacts while they remain
inside their configured retention window. Passing these checks is necessary
for audit continuity but cannot close `INFRA-CRITICAL-040`.

## WAL-G physical recovery chain

Production deploys remain locked until all of these are true:

- the derived production PostgreSQL image is running with continuous WAL
  archiving and `archive_timeout` no greater than 300 seconds;
- the latest uninterrupted sequence contains three distinct successful full
  base backups with signed integrity records;
- an explicit timestamp PITR from one of those backups demonstrates RPO at
  most 300 seconds and RTO at most 3,600 seconds in an isolated target;
- the read-only verifier accepts workflow identity, artifact/mirror parity,
  and the recovery bounds as integrity gates;
- a separately trusted DR executor and independent object authority provide
  the closure evidence required by `INFRA-CRITICAL-040`; and
- a dedicated backup SSH account and root-owned forced-command broker close
  the pre-payload login-shell boundary recorded by `INFRA-CRITICAL-044`;
- host-level egress policy restricts the backup bridge to approved endpoints
  and retains deny evidence for `INFRA-HIGH-042`;
- the qualifying PITR runs on separately trusted DR compute, outside the
  production host and Docker authority, as required by `INFRA-HIGH-043`;
- an independently captured, timestamp-bound source parity set matches the
  isolated restore target as required by `INFRA-HIGH-051`; and
- `scheduled-workflow-watchdog` reports both scheduled database workflows
  fresh and green.

Code, a dry run, a successful logical restore, or signed host-authored JSON
does not satisfy this stop-line. `INFRA-HIGH-033` stays open until the real
production evidence is preserved and evaluated. `INFRA-CRITICAL-040`,
`INFRA-CRITICAL-044`, `INFRA-HIGH-042`, `INFRA-HIGH-043`, and
`INFRA-HIGH-051` remain independent production blockers until their respective
authority and isolation evidence exists.

### WAL-G v3.0.8 PGDATA symlink prohibition

`INFRA-HIGH-056` records a WAL-G v3.0.8 limitation: its PostgreSQL backup path
does not preserve arbitrary symlink targets. A source link such as
`PGDATA/wal-g-secrets -> /run/aqua-walg-secrets` is archived and restored as
`PGDATA/wal-g-secrets -> /wal-g-secrets`. Therefore no credential file or
credential symlink may exist beneath PGDATA.

The runtime contract is fail closed:

- `WALG_SECRET_DIR` resolves directly to `/run/aqua-walg-secrets`;
- the loader atomically installs the manifest-bound bundle into that tmpfs and
  never creates a PGDATA symlink;
- `backup-push` must reject any unexpected PGDATA symlink before WAL-G starts;
- `backup-fetch` must be followed immediately by a non-following symlink scan,
  before secret installation or PostgreSQL startup; and
- an old backup containing `wal-g-secrets`, `/wal-g-secrets`, or another
  unapproved link is non-qualifying and must fail rather than be silently
  repaired.

The current deployment has no tablespace contract, so the accepted PGDATA
symlink set is empty. A future tablespace rollout requires an explicit
`pg_tblspc/<OID>` allowlist, independent target validation, and a new restore
drill before that exception can be admitted.

### One-time bootstrap

1. Set `WALG_SPACES_BUCKET`, `WALG_BACKUP_EPOCH`, `SPACES_ENDPOINT`, and
   `SPACES_REGION` in the droplet's protected production environment, using
   `.env.production.example` as the name contract. Compose derives
   `s3://<bucket>/postgres/wal-g/<epoch>`; operators must not hand-author a
   second prefix value.
2. Seed all 25 `production-backup` Environment secrets and four Environment
   variables listed above. Set the PITR principal to read-only object access,
   and bind its bucket/epoch/key tuple to the active source chain before the
   current-timestamp drill. Verify
   `DROPLET_SSH_FINGERPRINT` out of band before storing it; the workflows use
   the runner's native system OpenSSH client and accept only the advertised
   host key with that exact protected fingerprint. Give each storage principal
   access only to its named bucket and operation set. Enable versioning on
   `EVIDENCE_SPACES_BUCKET`, and install the public key matching
   `LOGICAL_BACKUP_GPG_RECIPIENT` in the production backup keyring.
3. From merged `main`, dispatch `Backup - Production Postgres` with
   `bootstrap_walg_secrets_only: true` and `dry_run: false`. This writes the
   five manifest-bound WAL-G values plus their manifest below
   `/var/aqua-saas/certs/wal-g/postgres` without putting secret values in
   container configuration. The adjacent `.lock` is synchronization state,
   not part of the five-value manifest.
4. On the droplet, verify the source directory is not a symlink, its mode is
   `0700`, each credential/manifest is a regular non-symlink with mode `0600`,
   and `sha256sum --strict --status -c manifest.sha256` succeeds. Do not print
   file contents.
5. Deploy the derived PostgreSQL image at the exact merged-main SHA/tag. Verify
   its OCI revision and WAL-G revision, then verify that the boot installer
   copied credentials into `/run/aqua-walg-secrets` tmpfs and left no path at
   `PGDATA/wal-g-secrets`.
6. Verify configuration without exposing environment or secret files:

   ```bash
   docker exec aqua-postgres psql -X -qAt -U aquaculture -d aquaculture \
     -c "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('archive_mode','archive_command','archive_timeout') ORDER BY name;"
   docker exec --user postgres aqua-postgres \
     /usr/local/bin/walg-runtime-command.sh assert-runtime
   ```

### Three signed base-backup records

The 03:00 UTC workflow runs an explicit full `backup-push --verify`, validates
the WAL chain, completes the client-encrypted snapshot-bound logical dump, then
transports the host-authored record to the runner with native system OpenSSH
after an exact protected host-key fingerprint match. The runner signs and
mirrors that record, but the result remains an integrity signal rather than
independent closure evidence.

Run three non-dry `Backup - Production Postgres` executions from merged
`main`, with `dry_run: false` and `bootstrap_walg_secrets_only: false`. For
each run:

1. Confirm both `backup` and `publish-evidence` jobs succeeded.
2. Record the run id, attempt, merged-main SHA, explicit `base_*` name, and
   exact artifact name.
3. Confirm the artifact contains both signed records and that the
   content-addressed mirror bucket has versioning enabled.

Dry runs and bootstrap-only runs do not enter the sequence. A failed full run
breaks the sequence. `LATEST` is never an acceptable recovery selector.

### Protected isolated timestamp PITR

After the three qualifying base backups, dispatch
`.github/workflows/pitr-restore-production.yml` (`PITR Restore - Production
Postgres`) from the same merged `main` SHA with an explicit `base_*` backup
name and `confirm_disposable_reset: true`. Do not supply a recovery timestamp,
sentinel timestamp, RPO, or RTO; the workflow and database derive them.

The workflow must create a run-labeled target volume and dedicated isolated
network, start the exact source image, publish no port, share no production
network or writable mount, and erase only the positively attested target
PGDATA. The source system identifier must equal
`PITR_SOURCE_SYSTEM_IDENTIFIER`, and image/WAL-G revisions must match the
merged-main manifests.

The PITR workflow must not rotate or reinstall the live source bundle. It
materializes the `PITR_WALG_*` tuple only beneath its private run-scoped runtime
directory, bind-mounts that directory read-only into the disposable target,
and proves the source bundle digest is unchanged throughout the source archive
fence. Because this drill derives a current source timestamp, the selected
PITR bucket/epoch must equal the active source archive chain; a historical
epoch requires a separately defined historical target-time ceremony and stays
tracked by `INFRA-HIGH-062`.

Success requires all of the following:

- the archive switch is observed within 300 seconds and WAL verification
  succeeds for the explicit backup, timeline, and LSN;
- recovery promotes the target and proves the `BEFORE` sentinel exists while
  the `AFTER` sentinel does not;
- conservative RPO is at most 300 seconds and measured RTO is at most 3,600
  seconds;
- the restored database passes target-internal 17-schema, tenant-ledger,
  migration-head, sentinel-count, and checksum verification; and
- the integrity record binds source system id, image/WAL-G revisions,
  network/volume labels, commit fences, archive result, and verification hash.

The canonical PITR verifier computes those counts and checksums only on the
restore target. They prove target structure and internal consistency, but do
not compare restored application rows with a source-side snapshot and therefore
do not prove source application parity. `INFRA-HIGH-051` remains open until an
independently captured, source-bound application baseline is compared with the
restored target.

### Verify enterprise integrity

Dispatch `.github/workflows/verify-backup-dr-closure.yml` from merged `main`.
The read-only job must resolve exact run attempts, verify safe artifact members
and digests, verify Cosign/Rekor identities, compare signed bytes with the
versioned content-addressed mirror, and evaluate the uninterrupted backup/PITR
sequence.

Preserve the workflow URL and evaluator JSON. An `ok: true` result and
fresh/green schedules prove only the current integrity gates. They cannot
authorize lifting the production deploy lock while any of
`INFRA-CRITICAL-040`, `INFRA-CRITICAL-044`, `INFRA-HIGH-042`,
`INFRA-HIGH-043`, or `INFRA-HIGH-051` lacks its required authority or
isolation evidence.

**Purpose:** verify that the nightly backups produced by
`tools/scripts/database/backup-databases.sh` can actually be restored, end to
end, on a clean Postgres instance. A backup whose restore path has never been
exercised is not a backup — it's optimism. Closes
`docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-BACKUP-002`.

**Cadence:**

- Once per calendar quarter.
- After any change that touches `tools/scripts/database/backup-databases.sh`,
  `tools/scripts/database/restore-databases.sh`,
  `tools/scripts/database/database-verification.sql`, the `pg_dump`/`pg_restore`
  flags in `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`,
  or the schema ownership model.
- Before any planned PostgreSQL major-version upgrade.

**Owner:** infra on-call. Runs during a business-hours window; nothing touches
production state.

---

## 1. Prerequisites

On the machine running the drill (a local workstation or a spare droplet —
NOT the production droplet):

| Tool    | Minimum version | Install                                                    |
| ------- | --------------- | ---------------------------------------------------------- |
| Docker  | 24.0            | [docs.docker.com](https://docs.docker.com/engine/install/) |
| AWS CLI | v2              | `snap install aws-cli --classic` or distribution package   |
| `gpg`   | 2.2             | required to decrypt every client-encrypted logical dump    |

Provision a read-only drill credential for the logical-backup bucket. Do not
copy the WAL-G, evidence-publisher, or evidence-verifier credentials onto the
drill host. Import the independently escrowed decryption key into an ephemeral
drill-only GPG home; never place it on the production droplet:

```bash
export LOGICAL_BACKUP_SPACES_BUCKET='<logical backup bucket>'
export LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID='<read-only drill key id>'
export LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY='<read-only drill key secret>'
export SPACES_ENDPOINT='https://fra1.digitaloceanspaces.com'
export SPACES_REGION='fra1'
export SPACES_BUCKET="${LOGICAL_BACKUP_SPACES_BUCKET}"
export AWS_ACCESS_KEY_ID="${LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY}"
export AWS_REGION="${SPACES_REGION}"
export AWS_DEFAULT_REGION="${SPACES_REGION}"
export BACKUP_GPG_KEY='<escrowed private-key fingerprint>'
```

The restore drill does not request or validate Spaces SSE-S3 because that
control is unsupported by this contract and is not relied on. The selected
dump and its verification sidecar must both be client-encrypted GPG objects.
`BACKUP_GPG_KEY` is the exact 40-hex primary secret-key fingerprint; the restore
fails before decryption unless exactly one matching escrowed secret key exists.

## 2. Identify the backup to restore

Pick the most recent dump object by convention; ignore keys ending in
`.verification.json.gpg`. For a post-incident drill, pick the dump immediately
preceding the incident window.

```bash
aws s3 ls "s3://${SPACES_BUCKET}/pg-backups/$(date -u +%Y/%m/%d)/" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --recursive
```

Copy the full object key — example:

```
pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump.gpg
```

Record the dump's SHA-256, byte length, and verification-sidecar binding.
`restore-databases.sh` refuses objects that lack these fields or whose
reciprocal sidecar metadata disagrees:

```bash
aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key    "pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump.gpg" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '{bytes:ContentLength,sha256:Metadata.sha256,verificationKey:Metadata.verification_key,verificationSha256:Metadata.verification_sha256}'
```

## 3. Spin an ephemeral Postgres

Use the **same** `postgres` image and major version that runs on the
droplet. The droplet's image is pinned in `docker-compose.droplet.yml`; the
example below is derived from that file and must be updated if the compose
image changes.

```bash
docker network create drill-net 2>/dev/null || true
docker run -d \
  --name aqua-postgres-drill \
  --network drill-net \
  --label com.aqua-saas.restore.role=isolated-drill \
  -e POSTGRES_USER=aquaculture \
  -e POSTGRES_PASSWORD=drillpass \
  -e POSTGRES_DB=postgres \
  timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7

# Wait for readiness (≤30s typical)
until docker exec aqua-postgres-drill pg_isready -U aquaculture; do sleep 1; done
```

## 4. Restore

```bash
export TARGET_CONTAINER=aqua-postgres-drill
export TARGET_USER=aquaculture
export TARGET_DB=aquaculture_drill
export PGPASSWORD=drillpass
export BACKUP_KEY="pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump.gpg"
export MAX_RESTORE_SECONDS=3600
# BACKUP_GPG_KEY was set to the escrowed private-key fingerprint above.

set -o pipefail
time bash tools/scripts/database/restore-databases.sh 2>&1 | tee drill-$(date -u +%Y%m%dT%H%M%SZ).log
```

Expected terminal output ends with a `RESTORE_VERIFIED` record followed by
`Done`. The command resolves `TARGET_CONTAINER` once to its immutable 64-hex
container ID, binds the label, mount, network, and no-published-port authority
to that ID, then re-attests the name-to-ID mapping immediately before the
destructive database reset. Every `docker exec` uses the captured ID. It also
prepares and finalizes TimescaleDB restore mode around `pg_restore`, and exits
non-zero if identity, verification, or the 60-minute RTO fails.
`MAX_RESTORE_SECONDS` may tighten the limit but cannot exceed 3,600 seconds.

## 5. Machine-enforced acceptance

The backup command and `pg_dump` share one exported PostgreSQL snapshot. The
backup uploads the collector's deterministic JSON only as the encrypted
`<dump-key>.verification.json.gpg` sidecar. Dump and sidecar metadata bind their
ciphertext hashes reciprocally; after exact-key decryption, the restore command
runs the same collector against the isolated database and requires
byte-for-byte plaintext parity. No manual row count can replace this gate.

This source-bound parity applies to the logical dump snapshot only. It does not
retroactively turn the physical PITR target's target-only checksums into source
application parity; `INFRA-HIGH-051` remains open for that physical recovery
claim.

Acceptance proves all of the following in one repeatable-read view:

- all 17 schemas from `bootstrapCreatedSchemas()` exist;
- every schema beginning with `tenant_` matches the canonical 16-hex tenant
  schema grammar; the physical set exactly matches non-deleted
  `admin.tenant_schemas` ledger rows, and every ledger mapping agrees with the
  tenant UUID-derived canonical schema name;
- all 14 source migration ledgers match the latest DB-complete release ledger;
- all seven tenant migration ledgers match their recorded tenant head, or the
  source head for tenants onboarded after that release;
- the global and per-tenant sentinel relation counts and order-independent row
  checksums exactly match the backup snapshot; zero rows are valid only when
  both sides prove the same zero-row checksum;
- the full download, restore, and verification completes within 3,600 seconds.

On any failure, preserve the command log and drill container and escalate to
`#aqua-incidents`. Do not label the object restorable.

## 6. Tear down

```bash
docker rm -f aqua-postgres-drill
docker network rm drill-net
```

## 7. Log the result

Append a row to the drill log (`docs/runbooks/_logs/database-restore-drills.md`
— create if it does not exist) with the following fields. This row is the
evidence we passed the drill.

| Date (UTC) | Operator | Workflow URL | Dump key | Dump bytes | Dump sha256 | Verification sha256 | Restore wall-clock | RTO ≤ 60m? | `RESTORE_VERIFIED` log line | Notes |
| ---------- | -------- | ------------ | -------- | ---------- | ----------- | ------------------- | ------------------ | ---------- | --------------------------- | ----- |

Commit the updated log in the same PR that fixes any issue the drill
surfaced; if the drill was clean, commit the log entry on its own.

## 8. Failure modes and next steps

| Symptom                                                | Likely cause                                                               | Next step                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_restore: error: could not read from input file`    | dump truncated during upload                                               | re-run `backup-databases.sh`; compare `head-object` bytes and `Metadata.sha256` against the workflow log                                                    |
| `pg_restore: error: role "xxx_service" does not exist` | dump was produced WITHOUT `--no-owner`                                     | patch `backup-databases.sh`; re-run                                                                                                                         |
| backup object is missing verification binding metadata | object predates the snapshot-bound proof contract or upload was incomplete | run a new non-dry backup; do not certify the legacy object                                                                                                  |
| restored database failed structural verification       | schema, tenant, sentinel relation, or migration head is missing/drifted    | preserve the drill container and inspect the prefixed `verification` error                                                                                  |
| count/checksum evidence differs                        | restored rows do not match the exact snapshot used by `pg_dump`            | preserve both object keys and the drill container; open an incident                                                                                         |
| verified restore exceeded RTO                          | end-to-end restore took more than 3,600 seconds                            | capture timings and storage/CPU/IO telemetry; production remains locked                                                                                     |
| `aws: error: An error occurred (403)`                  | logical drill key lost its ListObject/GetObject permission                 | rotate the read-only drill key; if production also fails, rotate the logical-backup Spaces principal                                                        |
| GPG decryption fails                                   | decryption-capable private key is absent from the isolated drill keyring   | load the private key only onto the isolated drill host under the approved key-handling procedure; remove it after the drill and never copy it to production |
