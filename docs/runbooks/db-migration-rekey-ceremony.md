# Runbook: SQLCipher v1→v2 rekey ceremony

**Owner:** edge platform team
**Related batches:** PR-194 (#329-#341 D-3 primitives + ADR-031); PR-195 (#1-#20 orchestration arc, end-to-end)
**Related plan:** Plan §5 Faz 2 D-3 (UH-017 closure — RESOLVED in PR-195 Batch #20)
**Related runbook:** [`db-migration-detection-failure.md`](./db-migration-detection-failure.md) — for triage of corrupt / mismatched / unreadable manifests
**Closes finding:** ULTRA-HIGH-017 (D-3 SQLCipher v1→v2 migration binary). Per-batch architectural traceability via UH-095 through UH-108 entries.

## Purpose

End-to-end procedure for migrating a deployed agent's SQLCipher databases from v1 (legacy `HMAC-SHA256(machine_id, secret_key)` derivation) to v2 (keystore-derived via `Keystore::derive_key` with per-consumer `KeyPurpose` + context bytes per ADR-031).

**This runbook is the as-built operator-facing contract as of PR-195 Batch #20.** The migration ceremony is a subcommand of the agent binary (`suderra-agent --migrate-db`); there is no separate `db-migrate-cli` binary.

## When to run the migration

Trigger signals (any one):

1. **Boot-detector WARN log** at agent startup: `event_kind="db_migration_backlog_summary" backlog_count=N` (N > 0). Operator dashboard surfaces the count via the `suderra_db_migration_backlog` Prometheus gauge.
2. **Pre-emptive fleet-wide upgrade** scheduled by platform team (e.g., before retiring the legacy `derive_db_encryption_key` path entirely).
3. **Audit signal** indicating the v1 derivation's machine-id-coupled threat model is operationally unacceptable for the device's tenant tier.

## Pre-flight checklist (operator MUST verify each before proceeding)

- [ ] **Recent verified backup of the agent's data directory** (`$SUDERRA_DATA_DIR`, default `/var/lib/suderra`). The migration is rollback-safe per the `RekeyManifestError::ManifestWriteFailed` rollback path (PR-195 Batch #3), but the double-failure case (`ManifestWriteFailedAndRollbackFailed`) requires backup restore. **Do NOT skip this step.**
- [ ] **Keystore enabled in agent config.** `keystore.mode` MUST be `Auto` or `FileBacked` (NOT `Disabled`). The migration ceremony refuses to run when the keystore subsystem is opt-out — there is no v2 derivation path possible without it. Provision `/etc/suderra/keystore.{passphrase,salt,acceptance.json}` per the keystore-bootstrap runbook before running migration.
- [ ] **Device provisioned with a real `device_id`.** `config.device_id` MUST NOT be empty or the canonical zero-UUID `00000000-0000-0000-0000-000000000000`. The dispatch helper hard-rejects unprovisioned devices because the v2 device-bound consumer context requires a real device UUID for tenant isolation (ADR-031).
- [ ] **Keystore master is reachable.** TPM-backed: TPM device responsive (`tpm2_getcap`). File-backed: `$SUDERRA_DATA_DIR/keystore_master.bin` present + readable. systemd-creds: agent service has access to the credential.
- [ ] **Agent service stopped** before running the migration ceremony. The ceremony requires exclusive write access to each SQLCipher DB; concurrent agent reads/writes during rekey would race on the page cache.
- [ ] **Boot-detector backlog report captured** for pre-state record:
  ```sh
  sudo systemctl stop suderra-agent
  # The boot detector's last-known backlog state is in the agent's
  # journal; capture it BEFORE migration so post-migration verification
  # has a known-good comparison point.
  journalctl -u suderra-agent --since="-1h" \
    | grep -E "db_migration_backlog_(entry|summary)" \
    > /tmp/pre-migration-backlog.log
  ```
- [ ] **Disk space verified.** The rekey rewrites every encrypted page; SQLCipher's WAL/journal needs ~1.5x the DB size as transient working space. `df -h $SUDERRA_DATA_DIR` should show ≥2x the largest DB's size free.

## Step-by-step procedure

### Step 1 — Run the migration ceremony

The migration is a subcommand of the agent binary, dispatched via `--migrate-db`:

```sh
sudo -u suderra suderra-agent \
  --migrate-db \
  --data-dir /var/lib/suderra \
  > /tmp/migration-result.jsonl 2>&1
```

**Required argument:** `--data-dir <path>` — the directory containing the SQLCipher consumer DBs. Same path as the agent's `$SUDERRA_DATA_DIR`.

**Optional argument:** `--dry-run` — computes + emits the migration plan without performing any rekey. Use this BEFORE the real run to verify which DBs the ceremony will touch + what schema_version each is currently at.

**JSONL output:** the ceremony emits ONE line per consumer outcome to stdout. The four canonical SqlCipher consumers (per `KNOWN_SQLCIPHER_CONSUMERS` in `db_migration::cli`) are processed in declaration order: `offline_queue.db`, `retain_persistence.db`, `license_cache.db`, `bytecode_retain.db`.

```jsonc
// Outcome shape — one of {migrated, skipped, failed} per consumer:

// Successful migration:
{"outcome":"migrated","purpose":"sqlcipher-offline-queue","from":"v1-machine-id-derived","to":"v2-keystore-derived"}

// DB doesn't exist yet (pre-deployment host or per-consumer not yet active):
{"outcome":"skipped","purpose":"sqlcipher-license-cache","reason":"no_db"}

// Already-v2 manifest (idempotent re-run of ceremony):
{"outcome":"skipped","purpose":"sqlcipher-offline-queue","reason":"already_v2"}

// Migration failed for this consumer (orchestrator continued to next):
{"outcome":"failed","purpose":"sqlcipher-retain-persistence","reason_class":"context"}
{"outcome":"failed","purpose":"sqlcipher-bytecode-retain","reason_class":"resolver"}
```

Failure `reason_class` values map to the underlying primitive:

| reason_class | Source | Meaning |
|---|---|---|
| `resolver` | `consumer_key_resolver::ResolverError` | Manifest read or composition failed (corrupt JSON, envelope mismatch, etc.) |
| `context` | `consumer_context::ConsumerContextError` | Bound-context bytes missing (program-bound consumer with no program SHA) |
| `v2_derivation` | `v2_keystore_key::V2DerivationError` | Keystore failed to derive the v2 key |
| `db_open` | DbOpen error | SQLCipher Connection::open or PRAGMA key apply failed |
| `rekey_swap` | `rekey_swap::RekeyManifestError` | The atomic rekey + manifest swap failed |

### Step 2 — Verify the migration outcome

```sh
# All-success check — every DB either migrated or skipped for benign reason.
jq 'select(.outcome == "failed")' /tmp/migration-result.jsonl
# Empty output = clean migration. Non-empty = recovery procedure (Step 3).
```

The agent's exit code reflects the aggregate: `0` if every consumer is `migrated` or `skipped`; `1` if ANY consumer is `failed`.

### Step 3 — Recover from any non-OK outcomes

#### 3.1 — Device-bound consumer failure (`offline_queue` / `license_cache` with `reason_class: "rekey_swap"`)

**Architectural state:** depends on the inner `RekeyManifestError`. Capture stderr around the failed entry — it carries the canonical `rekey_swap_*` prefix that names the failure mode.

**Operator action:**

- `rekey_swap_rekey_failed: …` → DB is **unchanged** (PRAGMA rekey is atomic). Address the root cause (filesystem, permissions, disk) and **re-run the ceremony** (idempotent — already-skipped consumers re-skip with `already_v2`).
- `rekey_swap_manifest_write_failed: …` (rollback succeeded) → DB is back to pre-call state. Address the manifest-side root cause + re-run.
- `rekey_swap_manifest_write_failed_and_rollback_failed: …` → **DB IN-DOUBT.** Stop. **Restore the affected DB + manifest from the pre-flight backup** then re-run the ceremony.

#### 3.2 — Program-bound consumer failure (`retain_persistence` / `bytecode_retain` with `reason_class: "context"`)

**Expected outcome on first migration.** Per ADR-031, program-bound consumer DBs are bound to a specific program's SHA-256 for v2 key derivation. At ceremony time, no program is loaded → `program_artifact_sha256: None` is plumbed into MigrationContext → resolver returns `ProgramSha256Required` → outcome class is `context`.

**This is NOT an error to recover from.** It is the explicit option-3 first-program-deploy migration discipline (closes ORPHAN-D3-BOOT-ORDER-002):

1. Operator runs the ceremony — device-bound DBs migrate; program-bound DBs report `failed:context`.
2. Operator boots agent — device-bound consumers open via manifest-aware constructor; program-bound consumers gracefully degrade to None state for v2 manifest hosts (Batch #19).
3. Operator deploys program via MQTT — the post-deploy hook (Batch #20) computes `program_sha = SHA-256(canonical_bytes(&entry.bytecode))` + opens the program-bound DB under the v2 keystore-derived key + SQLCipher save-back persists.

The program-bound DBs are RECREATED naturally on the next program deploy. No separate operator action is required.

#### 3.3 — Resolver failure (`reason_class: "resolver"`)

**Architectural state:** the manifest sidecar is corrupt, has an envelope-version mismatch, or is otherwise unparseable.

**Operator action:** see [`db-migration-detection-failure.md`](./db-migration-detection-failure.md) — different runbook; covers manifest triage paths.

### Step 4 — Post-migration verification

```sh
sudo systemctl start suderra-agent

# Tail the boot log; the boot detector should report:
#   - backlog_count=0 (no v1 DBs remaining for device-bound consumers)
#   - up_to_date_count matching the number of migrated DBs
#   - detection_failure_count=0
journalctl -u suderra-agent --since="-1m" \
  | grep -E "db_migration_backlog_(entry|summary|detection_failure)"

# Also verify the boot path used the manifest-aware constructor for
# device-bound consumers (Batch #17 init_X switches):
journalctl -u suderra-agent --since="-1m" \
  | grep -E "OfflineQueue \(manifest-aware\) initialized|License cache \(manifest-aware\) open"
```

Compare against `/tmp/pre-migration-backlog.log` from Step 0:

- **Pre-migration:** `backlog_count=N` (some positive number).
- **Post-migration:** `backlog_count=0` + `up_to_date_count=N`.

If the post-migration boot detector still reports `backlog_count > 0`, one or more device-bound DBs did not migrate — review `/tmp/migration-result.jsonl` for the missing entries + repeat Step 3 for them.

### Step 5 — Program-bound consumer recovery (post-deploy)

For each previously-deployed program that needs persistence post-migration:

```sh
# Re-deploy the program via the operator's deploy command path
# (e.g., MQTT cmd_deploy_bytecode_program payload, or the IDE deploy
# bridge). The agent's post-deploy hook (Batch #20) automatically:
#   1. Computes program_sha = SHA-256(canonical_bytes(&bytecode))
#   2. Calls AppState::try_open_program_bound_dbs_under_program_sha
#   3. Opens bytecode_registry_store + retain_persistence under v2 key
#   4. SQLCipher save-back persists the deploy
journalctl -u suderra-agent --since="-1m" \
  | grep -E "PR-195 Batch #20 post-deploy-open"
```

A successful post-deploy-open emits:
```
PR-195 Batch #20 post-deploy-open: RETAIN persistence opened under deploy's program_sha at /var/lib/suderra/retain.db (option-3 first-program-deploy migration discipline complete for this consumer)
```

A failed post-deploy-open emits a warning but does NOT fail the deploy — programs run without persistence per the pre-Batch-176/169 fail-tolerant patterns. A `PR-195 Batch #20 post-deploy-open FAILED` warning indicates the existing DB content was derived from a DIFFERENT program_sha (stale state from a previous program). Operator decides:

- **Recover:** delete the stale DB and re-deploy:
  ```sh
  sudo systemctl stop suderra-agent
  rm /var/lib/suderra/retain.db /var/lib/suderra/retain.db.key-source.json
  rm /var/lib/suderra/<bytecode_store_path> /var/lib/suderra/<bytecode_store_path>.key-source.json
  sudo systemctl start suderra-agent
  # then re-deploy the program via MQTT — the post-deploy hook
  # will recreate the DB under the new program's SHA.
  ```

## Architectural fail-safes (for operator awareness)

- **Atomic rekey:** SQLCipher's `PRAGMA rekey` is atomic at the page-cache level via WAL/journal. A power loss mid-rekey leaves the DB recoverable in either the OLD-key state OR the NEW-key state — never partial. (PR-195 Batch #1 module doc: `db_migration::rekey`.)
- **Atomic manifest swap:** The manifest sidecar JSON write uses the 6-step `temp + write + fsync + rename + parent-dir-fsync` sequence (PR-194 Batch #338, `shared_io::atomic_json_sidecar`). Power loss during manifest write leaves the OLD manifest intact OR the NEW manifest fully durable.
- **Transactional orchestration with rollback:** PR-195 Batch #3 (`rekey_with_manifest_swap`) wraps both atomicities into a single recoverable unit. Manifest-write failure after a successful rekey triggers an automatic rollback to the old key — DB returns to pre-call state.
- **Wrong-purpose runtime guard:** The v2 derivation shim (`db_migration::v2_keystore_key::derive_v2_sqlcipher_key`) rejects non-SqlCipher* `KeyPurpose` variants at the migration boundary, preventing accidental purpose substitution from silently producing 32 cryptographically valid but semantically wrong bytes (PR-194 Batch #332/#336/#337).
- **Zeroize harness:** The v2 key bytes return wrapped in `Zeroizing<[u8; 32]>`; the hex form returns `Zeroizing<String>`. Both scrub on Drop. SQLCipher's PRAGMA-key C-string is unscrubbable post-FFI but the Rust-side residue window is closed (PR-194 Batch #336).
- **Boot-order invariant:** PR-195 Batch #17 `tests/invariants/d3_boot_order.rs` enforces at CI time that `init_keystore` runs BEFORE every SQLCipher consumer's `init_X` in main.rs's boot sequence. A future refactor that mis-orders the boot sequence (e.g., re-adds `init_keystore` after `init_offline_queue`) fails this test rather than silently regressing the manifest-aware adoption.
- **HC-1 backward compat:** Agents with `keystore.mode = Disabled` continue to use the legacy v1-only constructors at boot. The migration ceremony refuses to run on such agents (clean error message naming the prerequisite). Operators upgrading from pre-keystore deployments enable `keystore.mode` first, then run `--migrate-db`.

## Plan-level context

Plan §5 Faz 2 D-3 (UH-017 — RESOLVED in PR-195 Batch #20):

```
Faz 2 D-3 SQLCipher v1→v2 migration arc (FULLY LANDED):
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

   Orchestration arc (PR-195 — 20 batches):
     #1  rekey kernel
     #2  stacked-PR ergonomics (SUDERRA_PREPUSH_BASE_REF)
     #3  rekey + manifest atomic swap with rollback
     #4  operator runbook (this document, refreshed in #21 to as-built)
     #5  sidecar tamper signal + 5-population classification
     #6  CLI scaffold + dry-run plan
     #7  consumer_context resolver (ADR-031 stability)
     #8  consumer_key_resolver SSoT (UH-096)
     #9  cli_executor orchestrator + CeremonyRuntime trait (UH-097)
     #10 cli_runtime BootstrappedCeremonyRuntime (UH-098)
     #11 execute_migration_ceremony unified API (UH-099)
     #12 run_migration_ceremony_with_context CLI execute (UH-100)
     #13 OfflineQueue manifest-aware constructor (UH-101)
     #14 db_secret SSoT + LicenseCache adoption (UH-102)
     #15 SqlitePersistence + BytecodeRegistryStore (UH-103)
     #16 keystore::bootstrap SSoT extraction (UH-104)
     #17 boot-order relocation + d3_boot_order invariant (UH-105;
         closes ORPHAN-D3-BOOT-ORDER-001)
     #18 main.rs --migrate-db arm wire-up (UH-106; closes
         ORPHAN-D3-CLI-DISPATCH-001)
     #19 program-bound init_X graceful-degradation (UH-107)
     #20 option-3 second-half post-deploy-open hook (UH-108;
         closes ORPHAN-D3-BOOT-ORDER-002 fully)
```

## Operator escalation channels

- **Routine `manifest_write_failed_rollback_succeeded`** (filesystem error, retry path): edge-platform-team Slack channel.
- **`manifest_write_failed_and_rollback_failed`** (in-doubt state, backup restore needed): platform-team-oncall PagerDuty + edge-platform-team incident channel. CRITICAL severity; SOC2 audit-trail entry required.
- **Boot detector reports `detection_failure` post-migration**: see [`db-migration-detection-failure.md`](./db-migration-detection-failure.md) (manifest unreadable / corrupt / envelope mismatch — different runbook).
- **`PR-195 Batch #20 post-deploy-open FAILED`** (program-bound DB stale state): edge-platform-team Slack; operator decision needed (delete-and-redeploy recovery OR investigate tenant-isolation expectations).

## Document version

This runbook reflects the as-built PR-195 Batch #20 implementation. The agent binary's `--migrate-db` subcommand IS the architectural contract; this document describes its observable behavior + the recovery procedures for each non-OK outcome class.

If the binary's behavior diverges from this document, the divergence is a bug in the BINARY, not in the runbook — the runbook is the contract. Updates to the binary's CLI shape, JSONL output schema, or recovery semantics MUST be accompanied by a runbook update in the same PR.
