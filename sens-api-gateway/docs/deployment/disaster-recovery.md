# Disaster Recovery Runbook

**Audience:** Plant IT operator + field engineer, jointly, with cloud tenant-admin access.
**Prerequisites:**
- Clear diagnosis of the failure mode (lost device / corrupt DB / revoked cert / site swap).
- Most recent known-good backup bundle available (see `backup-restore.md`).
- Cloud tenant-admin has `device:revoke` + `device:provision` permissions.
- Operator has scheduled a maintenance window — every DR path requires an agent stop, which removes actuator control.

**Duration:** 30–120 min depending on failure class and whether hardware replacement is involved.
**Blast radius:** single device or single site.
**Safety:** every DR path passes through a safe-state sequence. `SafeStateManager::apply` is the canonical entry point (`src/safe_state.rs:123`). If the agent cannot run safe-state (dead binary), plant operator must apply a physical lockout before proceeding.

---

## Failure triage

| Symptom | Path |
|---------|------|
| Device offline ≥ 15 min, no telemetry, no SSH | Path A — Lost device |
| Agent crash-loops with `PRAGMA integrity_check: *not ok` | Path B — Corrupt DB |
| Cloud shows `certificate revoked` or `auth denied` on MQTT | Path C — Revoked cert |
| Physical hardware replacement (board failure / enclosure swap) | Path D — Site swap |
| Full site power loss with data in offline queue | Path B + export-first subpath |

---

## Path A — Lost device

**Do:**
```
1. Cloud operator marks the device "quarantined" in tenant-admin UI.
2. Revoke the device certificate / MQTT credentials (cloud-side action).
3. Create a new bootstrap token with a different device_id than the lost device,
   or keep the same device_id if the hardware is merely off the network and
   you intend to resume on-device.
4. Dispatch a field engineer.
```

**Expect:** cloud-side audit entry `device.revoked`, `device.bootstrap_issued`.

**Verify:** in tenant-admin UI, device state is `quarantined`; issued token has `used_at: null`.

**On failure:** cannot revoke in cloud → escalate to platform operator. Do NOT issue a second token against a live credential set (both operators pointing at the same device creates undefined behaviour).

Once the device reappears:
- If state is recoverable (device is found + boots + has good backups): skip to Path C for credential refresh.
- If state is unrecoverable: Path D.

---

## Path B — Corrupt DB

**Symptoms:** agent journal shows `SQL logic error` or `database disk image is malformed`; or `PRAGMA integrity_check` returns anything other than `ok`.

**Step 1 — Quarantine the device**

**Do:**
```bash
sudo systemctl stop suderra-agent
# The stop path runs SafeStateManager::apply pre-exit; confirm completion.
journalctl -u suderra-agent --since "2 min ago" | grep -iE 'safe.state' | tail -5
```

**Expect:** safe-state log line present.

**Verify:** `systemctl is-active suderra-agent` → `inactive`.

**On failure:** agent refuses to stop (unlikely; systemd `TimeoutStopSec=90s` will kill) → let systemd kill, then plant operator must apply physical lockout.

**Step 2 — Export the offline queue before wipe**

**Do:** attempt to export still-readable rows before the full re-key. SQLCipher may allow partial reads even when `integrity_check` fails on later pages.

```bash
sudo -u suderra sqlcipher /var/lib/suderra/offline_queue.db <<'SQL'
PRAGMA key = '<site-key>';
.mode csv
.output /tmp/offline-queue-dump.csv
SELECT * FROM messages;  -- schema per src/offline_queue.rs
SQL
sudo chown root:root /tmp/offline-queue-dump.csv
sudo chmod 0600 /tmp/offline-queue-dump.csv
```

**Expect:** CSV exported. Some rows may be missing — this is the best the DB can offer.

**Verify:** `wc -l /tmp/offline-queue-dump.csv`.

**On failure:** DB refuses any SELECT → proceed without the export. The queue is lost.

**Step 3 — Wipe + re-seed state**

**Do:**
```bash
sudo install -d -o suderra -g suderra -m 0750 /var/lib/suderra/quarantine-$(date -u +%Y%m%d)
sudo mv /var/lib/suderra/offline_queue.db /var/lib/suderra/scada_state.db \
        /var/lib/suderra/quarantine-*/

# Let the agent re-create fresh SQLCipher DBs on next start.
sudo systemctl start suderra-agent
```

**Expect:** fresh DBs appear under `/var/lib/suderra/` with correct owner+mode; agent reports healthy.

**Verify:** `curl -sf http://localhost:6526/health && echo`.

**On failure:** agent still crash-looping → proceed to Path D; the hardware or filesystem is suspect.

**Step 4 — Push the exported rows back**

**Do:** ingest `/tmp/offline-queue-dump.csv` into the cloud via the existing telemetry CSV import path (tenant-admin → Ingest CSV). Keep the file mode 0600 on the operator's workstation throughout.

**Expect:** cloud absorbs the rows; duplicate-detection handles any already-published ones.

**Verify:** cloud telemetry dashboard backfills the rows into the right timestamps.

**On failure:** CSV rejected by schema → the dump may be malformed due to corruption. Escalate to the cloud operator for manual reconciliation.

---

## Path C — Revoked cert / credential refresh

**Step 1 — Confirm revocation**

**Do:**
```bash
journalctl -u suderra-agent --since "15 min ago" | \
    grep -iE 'mqtt.*denied|auth.*fail|certificate.*reject' | tail -10
```

**Expect:** auth-denied log lines.

**Verify:** tenant-admin shows `certificate revoked` or `credentials rotated` for this device.

**On failure:** no revocation found → this is not Path C; re-triage.

**Step 2 — Drive to safe state + re-provision**

**Do:**
```bash
sudo systemctl stop suderra-agent

# Keep a copy of config.yaml for audit.
sudo cp /etc/suderra/config.yaml \
        /etc/suderra/config.yaml.pre-reprovision.$(date -u +%s)

# Clear activated credentials but keep topology (modbus/gpio/i2c) blocks.
sudo -u root python3 - <<'PY'
import sys, yaml, pathlib
p = pathlib.Path("/etc/suderra/config.yaml")
cfg = yaml.safe_load(p.read_text())
for k in ("mqtt",):
    if k in cfg:
        cfg[k].update({"broker": None, "username": None, "password": None})
cfg["device_id"] = ""
cfg["tenant_id"] = None
p.write_text(yaml.safe_dump(cfg, sort_keys=False))
PY
sudo chown root:suderra /etc/suderra/config.yaml
sudo chmod 0600 /etc/suderra/config.yaml
```

**Expect:** cleared activation fields; topology config preserved.

**Verify:** `grep -E 'device_id|tenant_id|broker|username|password' /etc/suderra/config.yaml`.

**On failure:** YAML corruption after the Python edit → restore from `.pre-reprovision.*` copy and retry.

**Step 3 — Run provisioning**

Follow `provisioning.md` Steps 1–6 with a fresh bootstrap token.

**Expect:** credentials re-issued; MQTT reconnects cleanly; cloud sees device transition to `online`.

**Verify:** `provisioning.md` Step 6 commissioning evidence written.

**On failure:** activation rejected — follow `provisioning.md` Step 3 "On failure" table.

---

## Path D — Site swap (hardware replacement)

**Step 1 — Decommission the old device**

**Do:** follow `uninstall.md` on the old device up to and including the secure-wipe step. If the old device is unreachable, skip on-device steps and do cloud-side revoke-only.

**Expect:** cloud-side `device.decommissioned` audit entry.

**Verify:** tenant-admin UI shows the old device row as `decommissioned`.

**On failure:** cannot revoke → escalate; do not proceed until the old credentials are dead.

**Step 2 — Install new hardware**

Follow `install.md` Steps 1–7 on the replacement hardware. Use the same hostname where possible; the cloud correlates the new device record via the new `device_id`, not hostname.

**Expect:** fresh unactivated agent running on the replacement device.

**Verify:** `install.md` Step 7 post-conditions.

**On failure:** install fails — treat as a standalone install incident.

**Step 3 — Provision the new device**

Follow `provisioning.md`.

**Expect:** new `device_id` registered; old `device_code` may be re-used for operator continuity.

**Verify:** capabilities topic carries a retained message from the new device.

**On failure:** see `provisioning.md` On-failure matrix.

**Step 4 — (Optional) restore non-credential state**

Only restore state that is device-independent: nothing mTLS-bound, nothing keyed to the old `device_id`. Typical restorable state: SCADA trend data if the cloud has not already backfilled it.

**Do:** follow `backup-restore.md` Step 4, but override the device-ID check manually and **do not** restore `config.yaml` from the old bundle — that would re-install the revoked credentials.

**Expect:** SCADA DB on the new device reflects the pre-swap trend history.

**Verify:** local SCADA UI shows continuity.

**On failure:** cross-device restore refused → this is by design (`src/backup.rs:30-32`). If trend continuity is essential, the cloud operator must replay telemetry via the cloud → device downlink.

---

## Post-conditions (per path)

- Path A: device is either back online with refreshed credentials (flow into Path C/D) or formally retired in the cloud.
- Path B: agent is running on fresh DBs; exportable rows have been pushed back to the cloud.
- Path C: new credentials are active; old certs have `revoked_at` timestamps in the cloud audit log.
- Path D: new hardware is the new authoritative device record; old record is `decommissioned`.

## Rollback

DR paths are themselves rollback paths for upstream failures. A mid-DR abort rolls back to the **pre-DR quarantine**: agent stopped, device offline, cloud-side device quarantined. From quarantine you can:
- Re-attempt the same path.
- Switch paths if new evidence changes the triage.
- Escalate to the platform operator for a manual-reconciliation ticket.

## Appendix: Evidence

- `sens-api-gateway/src/safe_state.rs:76-150` — `SafeStateManager::apply` + `apply_single`.
- `sens-api-gateway/src/backup.rs:30-32` — device-ID bound restore (`verify_device_id = true`).
- `sens-api-gateway/src/offline_queue.rs` — SQLCipher-backed offline queue schema.
- `sens-api-gateway/src/scada_db.rs` — SCADA DB.
- `sens-api-gateway/src/provisioning.rs:337-420` — self-register flow for replacement hardware.
- `sens-api-gateway/systemd/suderra-agent.service:39-41` — `TimeoutStopSec=90s` (systemd hard-kill ceiling on stop).
- ADR-019 §7 — master key hierarchy (Tier 1 TPM → Tier 2 keyring → Tier 3 software fallback).
- ADR-020 — audit log append-only HMAC chain.
