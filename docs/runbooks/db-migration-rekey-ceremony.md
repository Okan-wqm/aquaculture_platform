# Runbook: SQLCipher v1→v2 rekey ceremony

**Owner:** edge platform team
**Related batches:** PR-194 (#329-#341 D-3 primitives + ADR-031); PR-195 (#1 rekey kernel, #3 atomic swap + rollback)
**Related plan:** Plan §5 Faz 2 D-3 (UH-017 closure)
**Related runbook:** [`db-migration-detection-failure.md`](./db-migration-detection-failure.md) — for triage of corrupt / mismatched / unreadable manifests
**Closes finding:** PR-195 closure-arc deliverable — operator-facing migration ceremony documentation

## Purpose

End-to-end procedure for migrating a deployed agent's SQLCipher databases from v1 (legacy `HMAC-SHA256(machine_id, secret_key)` derivation) to v2 (keystore-derived via `Keystore::derive_key` with per-consumer `KeyPurpose` + context bytes per ADR-031).

**This runbook is the operator-facing contract.** The architectural primitives that satisfy it are documented inline; future batches that ship the `db-migrate-cli` binary MUST conform to the procedures described here.

## When to run the migration

Trigger signals (any one):

1. **Boot-detector WARN log** at agent startup: `event_kind="db_migration_backlog_summary" backlog_count=N` (N > 0). Operator dashboard surfaces the count via the `suderra_db_migration_backlog` Prometheus gauge (post-consumer-migration arc).
2. **Pre-emptive fleet-wide upgrade** scheduled by platform team (e.g., before retiring the legacy `derive_db_encryption_key` path entirely).
3. **Audit signal** indicating the v1 derivation's machine-id-coupled threat model is operationally unacceptable for the device's tenant tier.

## Pre-flight checklist (operator MUST verify each before proceeding)

- [ ] **Recent verified backup of the agent's data directory** (`$SUDERRA_DATA_DIR`, default `/var/lib/suderra`). The migration is rollback-safe per the `RekeyManifestError::ManifestWriteFailed` rollback path (Batch #3), but the double-failure case (`ManifestWriteFailedAndRollbackFailed`) requires backup restore. **Do NOT skip this step.**
- [ ] **Keystore master is reachable.** TPM-backed: TPM device responsive (`tpm2_getcap`). File-backed: `$SUDERRA_DATA_DIR/keystore_master.bin` present + readable. systemd-creds: agent service has access to the credential.
- [ ] **Agent service stopped** before running the migration tool. The tool requires exclusive write access to each SQLCipher DB; concurrent agent reads/writes during rekey would race on the page cache.
- [ ] **Boot-detector backlog report captured** for pre-state record:
  ```sh
  systemctl stop suderra-agent
  # The boot detector's last-known backlog state is in the agent's
  # journal; capture it BEFORE migration so post-migration verification
  # has a known-good comparison point.
  journalctl -u suderra-agent --since="-1h" \
    | grep -E "db_migration_backlog_(entry|summary)" \
    > /tmp/pre-migration-backlog.log
  ```
- [ ] **Disk space verified.** The rekey rewrites every encrypted page; SQLCipher's WAL/journal needs ~1.5x the DB size as transient working space. `df -h $SUDERRA_DATA_DIR` should show ≥2x the largest DB's size free.

## Step-by-step procedure

### Step 1 — Run the migration tool

> **Note (PR-195 in-progress):** the `db-migrate-cli` binary is the entry point this runbook documents. The binary's argument shape + JSON-Lines output format are the architectural contract; the cargo target wires the existing primitives:
>
> - [`db_migration::manifest::read_manifest`](../../sens-api-gateway/src/db_migration/manifest.rs) (PR-194 Batch #329 + #338) — reads sidecar to determine current schema_version per DB.
> - [`db_migration::v1_legacy_key`](../../sens-api-gateway/src/db_migration/v1_legacy_key.rs) (PR-194 Batch #331 + #335) — pure HMAC-SHA256 kernel.
> - [`db_migration::v2_keystore_key`](../../sens-api-gateway/src/db_migration/v2_keystore_key.rs) (PR-194 Batch #332 + #336 + #337) — Zeroize-wrapped async shim around `Keystore::derive_key`.
> - [`db_migration::rekey_swap::rekey_with_manifest_swap`](../../sens-api-gateway/src/db_migration/rekey_swap.rs) (PR-195 Batch #3) — transactional rekey + manifest atomic swap with rollback.

```sh
sudo -u suderra db-migrate-cli \
  --data-dir /var/lib/suderra \
  --schema-target v2-keystore-derived \
  --output-format jsonl \
  > /tmp/migration-result.jsonl 2>&1
```

The tool emits ONE JSON object per DB processed. Schema:

```json
{
  "db_path": "/var/lib/suderra/offline_queue.db",
  "consumer": "offline_queue",
  "from_schema_version": "v1-machine-id-derived",
  "to_schema_version": "v2-keystore-derived",
  "outcome": "ok" | "rekey_failed" | "manifest_write_failed_rollback_succeeded" | "manifest_write_failed_and_rollback_failed",
  "duration_ms": 142,
  "error_reason": null | "<canonical rekey_swap_* prefix + reason text>"
}
```

### Step 2 — Verify the migration outcome

```sh
# All-success check — every DB rolled forward + post-rekey verify passed.
jq 'select(.outcome != "ok")' /tmp/migration-result.jsonl
# Empty output = clean migration. Non-empty = recovery procedure (Step 3).
```

### Step 3 — Recover from any non-OK outcomes

Per the `RekeyManifestError` taxonomy from Batch #3 (`db_migration::rekey_swap`):

#### 3.1 — `outcome: "rekey_failed"`

**Architectural state:** the DB is **unchanged**. PRAGMA rekey is atomic at SQLCipher's page-cache level; failure means the rekey didn't commit. The DB is still openable under the v1 key.

**Operator action:**

1. Inspect `error_reason`:
   - `rekey_hex_format_invalid: …` → bug in `db-migrate-cli` (input pre-validation should have caught this; file an issue).
   - `rekey_execute_failed: PRAGMA rekey failed: …` → SQLCipher rejected the new key. Check disk space, file permissions, kernel I/O errors via `dmesg | grep -iE "ext4|i/o error"`.
   - `rekey_post_verify_failed: …` → the rekey was issued but the post-rekey `SELECT count(*) FROM sqlite_master` round-trip failed. **DB may be in indeterminate state — proceed to Step 3.3.**
2. Address the root cause (filesystem, permissions, disk).
3. **Retry the migration tool** (it's idempotent for `rekey_failed`-classified DBs because no state changed).

#### 3.2 — `outcome: "manifest_write_failed_rollback_succeeded"`

**Architectural state:** the rekey happened, the manifest write failed, the rollback **succeeded** — DB is back to its pre-call state (openable under v1, manifest unchanged).

**Operator action:**

1. Inspect `error_reason` for the manifest-side failure (filesystem, disk full, permissions).
2. Address the manifest-side root cause.
3. **Retry the migration tool.** The DB is back to pre-state; idempotent.

#### 3.3 — `outcome: "manifest_write_failed_and_rollback_failed"`

**Architectural state:** the DB is in an **in-doubt state**. Neither the v1 key nor the v2 key may open it cleanly. **Do NOT retry the migration tool against this DB** — that would compound the in-doubt state.

**Operator action:**

1. **Stop**. Do not proceed with this DB until the recovery decision is made.
2. **Restore the affected DB** from the pre-flight backup. The agent's data directory backup taken at Step 0 is the recovery image:
   ```sh
   sudo systemctl stop suderra-agent
   cp /var/backups/suderra/<latest>/<db_name>.db \
      /var/lib/suderra/<db_name>.db
   cp /var/backups/suderra/<latest>/<db_name>.db.key-source.json \
      /var/lib/suderra/<db_name>.db.key-source.json
   ```
3. **File a CRITICAL audit-trail entry** with `error_reason` from BOTH the manifest_reason and rollback_reason fields. The double-failure case is rare and architecturally significant — platform team needs the diagnostic.
4. Re-run the migration tool against the restored DB after addressing whatever caused the original double-failure.

### Step 4 — Post-migration verification

```sh
sudo systemctl start suderra-agent

# Tail the boot log; the boot detector should report:
#   - backlog_count=0 (no v1 DBs remaining)
#   - up_to_date_count matching the number of migrated DBs
#   - detection_failure_count=0
journalctl -u suderra-agent --since="-1m" \
  | grep -E "db_migration_backlog_(entry|summary|detection_failure)"
```

Compare against `/tmp/pre-migration-backlog.log` from Step 0:

- **Pre-migration:** `backlog_count=N` (some positive number).
- **Post-migration:** `backlog_count=0` + `up_to_date_count=N`.

If the post-migration boot detector still reports `backlog_count > 0`, one or more DBs did not migrate — review `/tmp/migration-result.jsonl` for the missing entries + repeat Step 3 for them.

## Architectural fail-safes (for operator awareness)

- **Atomic rekey:** SQLCipher's `PRAGMA rekey` is atomic at the page-cache level via WAL/journal. A power loss mid-rekey leaves the DB recoverable in either the OLD-key state OR the NEW-key state — never partial. (Batch #1 module doc: `db_migration::rekey`.)
- **Atomic manifest swap:** The manifest sidecar JSON write uses the 6-step `temp + write + fsync + rename + parent-dir-fsync` sequence (PR-194 Batch #338, `shared_io::atomic_json_sidecar`). Power loss during manifest write leaves the OLD manifest intact OR the NEW manifest fully durable.
- **Transactional orchestration with rollback:** PR-195 Batch #3 (`rekey_with_manifest_swap`) wraps both atomicities into a single recoverable unit. Manifest-write failure after a successful rekey triggers an automatic rollback to the old key — DB returns to pre-call state.
- **Wrong-purpose runtime guard:** The v2 derivation shim (`db_migration::v2_keystore_key::derive_v2_sqlcipher_key`) rejects non-SqlCipher* `KeyPurpose` variants at the migration boundary, preventing accidental purpose substitution from silently producing 32 cryptographically valid but semantically wrong bytes (PR-194 Batch #332/#336/#337).
- **Zeroize harness:** The v2 key bytes return wrapped in `Zeroizing<[u8; 32]>`; the hex form returns `Zeroizing<String>`. Both scrub on Drop. SQLCipher's PRAGMA-key C-string is unscrubbable post-FFI but the Rust-side residue window is closed (PR-194 Batch #336).

## Plan-level context

Plan §5 Faz 2 D-3 (UH-017 parent finding):

```
Faz 2 D-3 SQLCipher v1→v2 migration arc:
   Primitives (PR-194):
     #329 schema_version + manifest sidecar
     #330 boot-time detector
     #331 v1 legacy-key kernel
     #332 v2 keystore-derived shim
     #333 wire-status invariants
     #335 v1 algorithm SSoT extraction
     #336 v2 Zeroize harness
     #337 KeyPurpose method + Display scrub
     #338 atomic_json_sidecar SSoT
     #339 timestamp floor + detection-failure runbook
     #340 empty-input debug_assert
     #341 ADR-031 KeyPurpose extension (4 SqlCipher consumers enumerated)
   Orchestration (PR-195 — this runbook documents):
     #1 rekey kernel
     #3 rekey + manifest atomic swap with rollback
     #4 operator runbook (THIS DOCUMENT)
     [next] db-migrate-cli binary entry point
     [next] per-consumer migration adoption
     [next] HIGH-002 sidecar tamper signal (DB-exists-but-no-sidecar arm)
```

When PR-195 closes, UH-017 D-3 arc transitions from OPEN to RESOLVED. Faz 2 then has only D-4 (mTLS rotation, UH-018) remaining.

## Operator escalation channels

- **Routine `manifest_write_failed_rollback_succeeded`** (filesystem error, retry path): edge-platform-team Slack channel.
- **`manifest_write_failed_and_rollback_failed`** (in-doubt state, backup restore needed): platform-team-oncall PagerDuty + edge-platform-team incident channel. CRITICAL severity; SOC2 audit-trail entry required.
- **Boot detector reports `detection_failure` post-migration**: see [`db-migration-detection-failure.md`](./db-migration-detection-failure.md) (manifest unreadable / corrupt / envelope mismatch — different runbook).

## Document version

This runbook is the architectural contract as of PR-195 Batch #4. The `db-migrate-cli` binary's actual implementation (subsequent PR-195 batches) MUST satisfy this contract. Any divergence between the binary's behavior and this document is a bug in the BINARY, not in the runbook — the runbook ships first as the contract.
