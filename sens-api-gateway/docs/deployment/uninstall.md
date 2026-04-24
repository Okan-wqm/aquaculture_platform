# Uninstall Runbook (IRREVERSIBLE — confirm before proceeding)

**Audience:** Field engineer at the device + plant IT operator with cloud tenant-admin access.
**Prerequisites:**
- Cloud tenant-admin confirms the device is being decommissioned (not merely paused). Decommissioning is announced to the plant operator.
- Backups per `backup-restore.md` Step 1 have been completed within the last 24 h and off-sited. This runbook destroys data.
- Plant operator confirms actuator outputs controlled by this device have been transferred to manual lockout or another device.

**Duration:** 15–30 min.
**Blast radius:** single device. The IRREVERSIBLE steps are marked below.
**Safety:** the uninstall path drives the device into safe state BEFORE revoking credentials. Step 2 is the canonical safe-state entry.

---

## Dangerous / irreversible steps (summary)

| # | Step | Why irreversible |
|---|------|------------------|
| 4 | Revoke device certificate / credentials in the cloud | Once revoked, only a fresh bootstrap token (new `device_id`) can re-enroll the hardware |
| 7 | `shred -u` on `/etc/suderra/db.key` and SQLCipher DBs | Deleted key material cannot be recovered; any SQLCipher DB still on offline backups becomes unreadable without the archived key envelope |
| 8 | `rm -rf /var/lib/suderra /var/log/suderra` | All on-device forensic evidence is gone |

Do not proceed past Step 3 without a signed authorisation in the plant change log.

---

## Step 1 — Snapshot final evidence

**Do:** create a final archive bundle per `backup-restore.md` Step 1, labelled `final-decomm`. This is the last chance to capture audit log + offline queue state.

```bash
# Follow backup-restore.md Step 1, with:
# BACKUP_NAME="suderra-${DEVICE_CODE}-FINAL-DECOMM-$(date -u +%Y%m%dT%H%M%SZ).tar.enc"
```

**Expect:** encrypted bundle off-sited; checksum recorded in the plant change log.

**Verify:** off-site listing shows the `FINAL-DECOMM` bundle.

**On failure:** cannot take a final backup → escalate. Do NOT proceed with uninstall — the audit log loss would be unreviewable.

---

## Step 2 — Drive to safe state

**Do:**
```bash
sudo systemctl stop suderra-agent
```

The stop path invokes `SafeStateManager::apply` (`src/safe_state.rs:123`) pre-exit. Every registered output tag is driven to its configured safe value.

**Expect:** journal shows
```
LIFE-SAFETY: applying safe-state to <N> actuator outputs
...
Shutdown complete
```

**Verify:**
```bash
journalctl -u suderra-agent --since "2 min ago" | grep -iE 'safe.state'
systemctl is-active suderra-agent   # inactive
```

**On failure:** safe-state apply reports errors → the plant operator must apply a physical lockout on the affected actuators before any further step. Do NOT continue without confirmed lockout.

---

## Step 3 — Get authorisation for irreversible steps

**Do:** confirm in writing (plant change log or equivalent):
- Cloud operator authorises certificate revocation.
- Plant operator authorises destruction of on-device state.
- Field engineer name + timestamp.

**Expect:** signed authorisation record.

**Verify:** log row visible in the change-management system.

**On failure:** missing authorisation → stop. You can leave the device in the safe-state/stopped configuration indefinitely; do not destroy data without sign-off.

---

## Step 4 — IRREVERSIBLE: Revoke cloud-side credentials

**Do:** cloud operator, in tenant-admin UI:
1. Revoke the device certificate / MQTT credentials.
2. Transition the device record to `decommissioned`.
3. Invalidate any outstanding bootstrap tokens keyed to this device.

**Expect:** cloud audit log rows `device.revoked`, `device.decommissioned`.

**Verify:** tenant-admin UI shows the device in `decommissioned` state; MQTT broker auth cache no longer accepts the device's credentials.

**On failure:** revoke button unresponsive → escalate to platform operator; do not proceed. If you destroy local credentials without cloud-side revoke, the cloud-side record dangles with a theoretically-valid credential.

---

## Step 5 — Disable and remove the systemd unit

**Do:**
```bash
sudo systemctl disable suderra-agent.service
sudo systemctl disable suderra-display.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/suderra-agent.service
sudo rm -f /etc/systemd/system/suderra-display.service
sudo systemctl daemon-reload
```

**Expect:** `systemctl cat suderra-agent` returns "no such unit".

**Verify:**
```bash
systemctl status suderra-agent suderra-display 2>&1 | grep -i 'could not be found' || true
```

**On failure:** unit still listed → the daemon-reload didn't take; re-run `systemctl daemon-reload`.

---

## Step 6 — Remove the binary

**Do:**
```bash
sudo rm -f /usr/local/bin/suderra-agent /usr/local/bin/suderra-agent.prev
sudo rm -rf /tmp/suderra-install /var/lib/suderra/updates
```

**Expect:** files gone.

**Verify:** `command -v suderra-agent || echo "absent"` → prints `absent`.

**On failure:** `Text file busy` → another process holds the binary open (should not be possible after Step 5's stop). Kill the process, retry.

---

## Step 7 — IRREVERSIBLE: Secure-wipe on-device secrets

**Do:**
```bash
# Key material + SQLCipher DBs — multi-pass overwrite where the filesystem supports it.
for f in /etc/suderra/db.key \
         /etc/suderra/client.key \
         /etc/suderra/client.pem \
         /etc/suderra/broker-ca.pem \
         /etc/suderra/config.yaml \
         /etc/suderra/config.yaml.*.bak \
         /var/lib/suderra/offline_queue.db \
         /var/lib/suderra/scada_state.db ; do
    [ -f "$f" ] && sudo shred -u -n 3 "$f" || true
done
```

**Expect:** every file removed. `shred` is best-effort on flash-backed storage and journaling filesystems (ext4 default-journal, f2fs, overlayfs); on those the canonical guarantee is "the filename + inode are freed" — the underlying flash cells may not be overwritten until wear-levelling reclaims them. That is why Step 4 (cloud-side revoke) must precede Step 7: even if a sector survives physical extraction, the credentials are already invalid.

**Verify:**
```bash
ls -la /etc/suderra/ /var/lib/suderra/ 2>/dev/null | tail -20
```
Expected result: no `*.key`, `*.pem`, `*.db` files remaining.

**On failure:** `shred` unavailable → install `coreutils` or use `dd if=/dev/urandom of=<path>` as a bridge procedure pending `shred` availability (manual procedure pending `shred-fallback` ROADMAP item).

---

## Step 8 — IRREVERSIBLE: Remove data directories

**Do:**
```bash
sudo rm -rf /etc/suderra /var/lib/suderra /var/log/suderra
```

**Expect:** directories gone.

**Verify:** `ls /etc/suderra /var/lib/suderra /var/log/suderra 2>&1 | tail -3` → three `No such file or directory` lines.

**On failure:** `rm: cannot remove ...: Device or resource busy` → a mount point overlapped with one of the paths. Unmount first (`umount <path>`) before retry.

---

## Step 9 — Remove the suderra system user

**Do:**
```bash
sudo userdel suderra
sudo groupdel suderra 2>/dev/null || true
```

**Expect:** `id suderra` returns "no such user".

**Verify:** `id suderra 2>&1`.

**On failure:** processes still owned by `suderra` → find and kill them, retry.

---

## Step 10 — Remove optional kiosk dependencies

**Do:** only if the device is being repurposed; leave installed otherwise:
```bash
sudo apt-get remove --purge -y cage chromium-browser || true
sudo apt-get autoremove -y
```

**Expect:** packages removed.

**Verify:** `dpkg -l cage chromium-browser 2>&1 | tail -3`.

**On failure:** APT reports dependency issues → skip this step; not required for decommission correctness.

---

## Step 11 — Commission log close-out

**Do:** append the decommission record to the cloud-side audit and plant log:
```bash
echo "$(date -u +%FT%TZ) DECOMMISSIONED operator=<name>" \
    >> /tmp/suderra-decomm-${DEVICE_CODE:-unknown}.log
```

Then file the log with the plant change management system. The local `/var/log/suderra/` is gone; this step creates a decommission record outside the purged paths.

**Expect:** decommission log stored in the change-management system.

**Verify:** change-management ticket shows the decommission record attached.

**On failure:** if your plant does not have a change-management system, file the record in the operator's shared SharePoint / Confluence space.

---

## Post-conditions

- Cloud operator sees `device.decommissioned` with a valid timestamp; credentials are revoked.
- Device binary, systemd unit, dedicated user, config, keys, DBs, and logs are removed.
- Final evidence bundle is off-sited.
- Decommission log is filed outside the destroyed paths.

## Rollback

There is no in-place rollback once Steps 4 / 7 / 8 execute. To bring the hardware back online:

1. Treat it as a fresh device: run `install.md` from Step 1.
2. Obtain a fresh bootstrap token against a NEW `device_id` (the old one is decommissioned — do not reuse).
3. Run `provisioning.md`.

## Appendix: Evidence

- `sens-api-gateway/src/safe_state.rs:76-150` — `SafeStateManager::apply` + per-output `apply_single`.
- `sens-api-gateway/systemd/suderra-agent.service:39-41` — `TimeoutStopSec=90s` hard-kill ceiling.
- `sens-api-gateway/scripts/setup-display.sh:174-203` — kiosk `uninstall` subcommand (parallels Step 5).
- `sens-api-gateway/src/backup.rs:30-32` — device-ID bound restore (enforces fresh-`device_id` rollback path above).
- ADR-018 §7 — master-key in-process defence (`shred` + cloud revoke are complementary; neither is sufficient alone).
