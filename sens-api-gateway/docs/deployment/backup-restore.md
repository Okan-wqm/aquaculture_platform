# Backup & Restore Runbook

**Audience:** Field engineer, plant IT.
**Prerequisites:**
- Device is installed and either activated or mid-commissioning.
- Secure backup destination available (off-site storage bucket, encrypted USB, site-master key for bundle encryption).
- Operator knows the site-master key (symmetric key for backup bundle encryption) — never stored on the edge device.

**Duration:** 10–20 min per device; 1–2 min scripted on a cronned cadence.
**Blast radius:** single device.
**Safety:** backup is read-only on the device; no safe-state action required. Restore is destructive — see the IRREVERSIBLE label below.

---

## What gets backed up

| Path | What | Why |
|------|------|-----|
| `/etc/suderra/config.yaml` | activated config incl. redacted-debug secrets | device re-hydration |
| `/etc/suderra/*.pem` (when present) | broker CA, client cert/key | mTLS trust bundle |
| `/etc/suderra/db.key` (when present) | SQLCipher master-key envelope | SQLCipher unlock on restore |
| `/var/lib/suderra/offline_queue.db` | SQLCipher offline message queue | un-replicated telemetry recovery |
| `/var/lib/suderra/scada_state.db` | SCADA DB (`src/scada_db.rs`) | HMI + trend data |
| `/var/lib/suderra/backups/` | backup manifests emitted by `src/backup.rs` | prior snapshots for retention |
| `/var/log/suderra/audit.log` | append-only HMAC-chained audit log (ADR-020) | forensic evidence |

Reference: `src/backup.rs:1-110` — backup manifest format (header + version + device_id + entries); per-device key binding prevents cross-device restore (`verify_device_id = true`).

---

## Step 1 — Create a backup

**Do:**
```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
DEVICE_CODE=$(sudo -u suderra awk '/^device_code:/ {print $2}' /etc/suderra/config.yaml | tr -d '"')
BACKUP_DIR=/var/lib/suderra/backups
BUNDLE_DIR=/tmp/suderra-backup-${TS}

sudo install -d -o suderra -g suderra -m 0750 "$BACKUP_DIR"
sudo install -d -o suderra -g suderra -m 0700 "$BUNDLE_DIR"

# Stop/quiesce is NOT required — SQLCipher read-consistent snapshot is safe at runtime.
# (See src/backup.rs :: BackupManager::create_backup.)
# The agent emits a backup manifest file under /var/lib/suderra/backups/ per call.

sudo rsync -a --chmod=F600,D700 \
    /etc/suderra/config.yaml \
    /etc/suderra/*.pem \
    /etc/suderra/db.key \
    /var/lib/suderra/offline_queue.db \
    /var/lib/suderra/scada_state.db \
    /var/log/suderra/audit.log \
    "$BUNDLE_DIR/" 2>/dev/null || true   # tolerate missing optional files

# Integrity check BEFORE bundling — reject broken SQLCipher DB.
sudo -u suderra sqlcipher /var/lib/suderra/offline_queue.db \
    "PRAGMA key = '<site-key>'; PRAGMA quick_check;" \
    | grep -q '^ok$' && echo "offline_queue.db OK"

# Encrypt the bundle with the site-master key.
sudo tar -cf - -C "$BUNDLE_DIR" . | \
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
    -pass file:/root/.site-master-key \
    -out "$BACKUP_DIR/suderra-${DEVICE_CODE}-${TS}.tar.enc"
sudo chmod 0600 "$BACKUP_DIR/suderra-${DEVICE_CODE}-${TS}.tar.enc"
sudo shred -u "$BUNDLE_DIR"/* && sudo rmdir "$BUNDLE_DIR"
```

**Expect:** encrypted backup file in `/var/lib/suderra/backups/` with mode 0600. `shred` removes staging copies.

**Verify:**
```bash
ls -l /var/lib/suderra/backups/suderra-${DEVICE_CODE}-${TS}.tar.enc
file /var/lib/suderra/backups/suderra-${DEVICE_CODE}-${TS}.tar.enc   # openssl enc'd data
```

**On failure:**
- `PRAGMA quick_check` returns anything other than `ok` → the DB is corrupt. Do NOT bundle it. Proceed to `disaster-recovery.md` → "Corrupt DB".
- `openssl enc` reports key file not found → the site-master key material is absent on this device. Stash it out-of-band before retry. Never inline the key in the script.

---

## Step 2 — Off-site the backup

**Do:** copy the encrypted bundle to the off-site destination through the operator's approved secure channel:

```bash
# Example — S3/MinIO with per-device prefix:
mc cp "$BACKUP_DIR/suderra-${DEVICE_CODE}-${TS}.tar.enc" \
    myoffsite/suderra-backups/${DEVICE_CODE}/
```

**Expect:** off-site copy acknowledgement.

**Verify:** list the remote object and confirm size matches.

**On failure:** network issue → retain the local copy and retry on the next cron tick. Local retention is governed by `src/backup.rs` `max_backups` (default 10).

---

## Step 3 — Schedule recurring backups

**Do:** install a systemd timer so backups are not operator-remembered:

> **systemd timer unit NOT YET IN REPO — Q3**. Until the repo ships the timer unit, install the following operator-side unit on each device. Canonical unit file lands in `sens-api-gateway/systemd/` in Q3.

```ini
# /etc/systemd/system/suderra-backup.service
[Unit]
Description=Suderra daily backup
After=suderra-agent.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/sbin/suderra-backup.sh
```

```ini
# /etc/systemd/system/suderra-backup.timer
[Unit]
Description=Suderra daily backup timer

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now suderra-backup.timer
```

**Expect:** `systemctl list-timers suderra-backup.timer` shows a next-run timestamp within 24 h.

**Verify:**
```bash
systemctl list-timers suderra-backup.timer
```

**On failure:** timer disabled → re-enable; check `suderra-backup.service` journal for script errors.

---

## Step 4 — Restore (IRREVERSIBLE — confirm before proceeding)

Restore replaces on-device state with the backup snapshot. Any telemetry queued locally since the backup is lost unless separately exported. **Confirm with the cloud operator and plant operator before running.**

**Do:**
```bash
# 4.1 Safe-state first — restore destroys the offline queue.
sudo systemctl stop suderra-agent

# 4.2 Decrypt the bundle on a clean staging dir.
STAGE=/tmp/suderra-restore-$(date -u +%s)
sudo install -d -o root -g root -m 0700 "$STAGE"
sudo openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass file:/root/.site-master-key \
    -in /var/lib/suderra/backups/suderra-<CODE>-<TS>.tar.enc | \
    sudo tar -xf - -C "$STAGE"

# 4.3 Integrity gate — refuse to restore a corrupt bundle.
sudo -u root sqlcipher "$STAGE/offline_queue.db" \
    "PRAGMA key = '<site-key>'; PRAGMA integrity_check;" | \
    grep -q '^ok$' || { echo "BUNDLE CORRUPT — ABORTING"; exit 2; }

# 4.4 Device-ID binding — refuse cross-device restore.
BUNDLE_DEV=$(grep -E '^device_id:' "$STAGE/config.yaml" | awk '{print $2}' | tr -d '"')
LIVE_DEV=$(grep -E '^device_id:' /etc/suderra/config.yaml | awk '{print $2}' | tr -d '"')
[ "$BUNDLE_DEV" = "$LIVE_DEV" ] || { echo "DEVICE ID MISMATCH — ABORTING"; exit 2; }

# 4.5 Overwrite state.
sudo install -m 0600 -o root -g suderra "$STAGE/config.yaml" /etc/suderra/config.yaml
sudo cp "$STAGE"/*.pem /etc/suderra/ 2>/dev/null || true
sudo install -m 0600 -o suderra -g suderra "$STAGE/offline_queue.db" \
    /var/lib/suderra/offline_queue.db
sudo install -m 0600 -o suderra -g suderra "$STAGE/scada_state.db" \
    /var/lib/suderra/scada_state.db
sudo -u suderra tee -a /var/log/suderra/audit.log < "$STAGE/audit.log" > /dev/null

sudo shred -u "$STAGE"/* 2>/dev/null || true
sudo rmdir "$STAGE"

# 4.6 Start agent.
sudo systemctl start suderra-agent
```

**Expect:** agent starts cleanly; MQTT reconnects with restored credentials; SCADA trend data resumes from the backup snapshot.

**Verify:**
```bash
systemctl is-active suderra-agent
curl -sf http://localhost:6526/health && echo
journalctl -u suderra-agent --since "2 min ago" | tail -20
```

**On failure:**
- Integrity gate reports anything other than `ok` → the bundle cannot be trusted. Go to `disaster-recovery.md` → "Corrupt DB".
- Device-ID mismatch → this bundle belongs to a different device. Do not overwrite — the `verify_device_id = true` invariant in `src/backup.rs:30-32` exists to prevent exactly this.
- Agent fails to start after restore → check `systemctl status`; follow the journal; if the config schema drifted (backup from an older agent version), consult the relevant migration notes per release.

---

## Post-conditions

- `/var/lib/suderra/backups/` holds the encrypted bundle.
- Off-site storage has a copy.
- Recurring timer is enabled.
- (Restore path only) agent is running on restored state; plant operator has confirmed resumption.

## Rollback

A failed restore mid-procedure leaves the device inconsistent. Rollback = re-run restore from the **most recent pre-failure backup**:

```bash
# Identify the last known-good bundle:
ls -lt /var/lib/suderra/backups/*.tar.enc
# Repeat Step 4 with that bundle.
```

If no good bundle exists, decommission + re-provision: `uninstall.md` → `install.md` → `provisioning.md`. Offline-queue data queued between the last good backup and the incident is lost.

## Appendix: Evidence

- `sens-api-gateway/src/backup.rs:1-110` — backup manifest format, retention policy, device-ID binding.
- `sens-api-gateway/src/backup.rs:108` — HTTP-exposed backup auth secret (EDGE-MEDIUM-006).
- `sens-api-gateway/systemd/suderra-agent.service:94` — `ReadWritePaths=/var/lib/suderra /var/log/suderra` (backup staging targets).
- `sens-api-gateway/src/scada_db.rs` — SCADA DB schema + `PRAGMA key` wiring.
- ADR-020 — append-only HMAC-chained audit log.
