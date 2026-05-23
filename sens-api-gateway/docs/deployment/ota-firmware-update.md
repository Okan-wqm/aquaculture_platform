# OTA Firmware Update Runbook

**Audience:** Plant IT operator or fleet operator issuing a firmware update; field engineer on the device for manual recovery paths.
**Prerequisites:**
- Device is activated; MQTT session is up; agent is emitting telemetry.
- Release pipeline has produced a signed firmware manifest (`SignedFirmwareManifest`, `src/updater/manifest.rs`) plus the target artefact.
- Operator has permission `device:update` in the cloud RBAC.
- Clock sync is trusted (freshness gate rejects skewed manifests — `src/updater/verify.rs:55-60`).

**Duration:** 5–15 min per device for baseline updates; longer cold-boot on SIMATIC IPC (bootloader budget).
> RC3 status (`agent-v2.0.0-rc3`): release artifacts are signed and published by GitHub Actions, but automatic device-side OTA enforcement is not claimed for RC3. Use `docs/runbooks/edge-gateway-ota.md` and `docs/runbooks/edge-gateway-rc3-operator.md` for the supported operator-controlled install path.

> RC3 stop rule: do not install an artifact unless checksum and cosign verification both pass against the tag-scoped workflow identity `edge-agent-release.yml@refs/tags/agent-v2.0.0-rc3`.

---

**Blast radius:** single device; extends to fleet when driven through the cohorted rollout in `fleet-ops.md`.
**Safety:** `SafeStateManager::apply` is invoked in the shutdown sequence (`src/safe_state.rs:76-150`) before any actuator-bearing output loses control. A systemd stop alone does not hard-cut outputs; safe-state drive is explicit.

---

## Honest roadmap disclosures (read before Step 1)

- **ORPHAN-EDGE-004:** the module `src/updater/` in v1.6.0 exports manifest types + the closure-injected `verify_firmware_manifest` function (`src/updater/verify.rs:48-60`). The closure slot for signature verification is NOT wired to `ed25519_dalek` in the runtime path — Sprint 6.5 wires it. **Today signature verify is a bypass point.** Until Sprint 6.5 lands, OTA updates MUST be restricted to a signed-transport channel (HTTPS-with-pinned-cert download, MQTT over mTLS) and every update artefact MUST be reviewed by a second operator (two-person integrity).
- **A/B partition swap** — NOT present today. The flow below performs in-place binary replace inside a systemd transaction. The A/B model (tryboot overlay + cold-boot budget + bootloader flag) is the Q4 roadmap (ADR-019 §2).
- **TPM anti-rollback NV counter** — gated by the `tpm` Cargo feature (default-off). When off, the monotonic version gate still runs in software (`src/updater/verify.rs:55-60` gate 5) against `highest_seen_firmware_version`, persisted via the keystore.

---

## Step 1 — Pre-flight on the device

**Do:**
```bash
# Confirm agent health before touching the binary.
curl -sf http://localhost:6526/health && echo
systemctl is-active suderra-agent
systemctl show suderra-agent -p MainPID,NRestarts,ActiveEnterTimestamp
journalctl -u suderra-agent --since "10 min ago" | grep -iE 'error|warn' | tail -20
```

**Expect:** health endpoint returns 200 OK JSON; `NRestarts` is low; no fresh errors in the last 10 min.

**Verify:**
```bash
df -h /var/lib/suderra          # ≥ 512 MB free for update staging
df -h /usr/local/bin            # ≥ 64 MB free for new binary
```

**On failure:** health not ready → investigate + stabilise before updating. Updating an already-degraded device turns one incident into two.

---

## Step 2 — Drive to safe state

**Do:** issue a safe-state command from the cloud (operator-signed, `signed-deploy` feature ON) or, in a maintenance window with operator confirmation, stop the agent gracefully:

```bash
# Option A — operator-signed safe-state command over MQTT (preferred).
# Option B — systemd stop, which runs the on-shutdown SafeStateManager pass
#            (src/main.rs shutdown sequence invokes SafeStateManager::apply).
sudo systemctl stop suderra-agent
```

**Expect:** journal shows
```
LIFE-SAFETY: applying safe-state to <N> actuator outputs
...
Shutdown complete
```

**Verify:**
```bash
journalctl -u suderra-agent --since "1 min ago" | grep -iE 'safe.state' | tail -5
systemctl is-active suderra-agent   # expected: inactive
```

**On failure:** safe-state apply reports an error for a subset of outputs → inspect `src/safe_state.rs::apply_single` trace. Do NOT proceed with the update while actuators are in an unknown state. Recover manually (physical lockout) before continuing.

---

## Step 3 — Stage the new binary

**Do:**
```bash
# Fetch signed manifest + artefact via the cloud-managed channel.
# Example using pre-staged files:
sudo install -d -o suderra -g suderra -m 0750 /var/lib/suderra/updates
sudo install -m 0644 -o suderra -g suderra \
    suderra-agent_1.6.1_aarch64.tar.gz \
    /var/lib/suderra/updates/
sudo install -m 0644 -o suderra -g suderra \
    suderra-agent_1.6.1_aarch64.manifest.json \
    /var/lib/suderra/updates/

# Verify SHA-256 digest shipped out-of-band.
cd /var/lib/suderra/updates
sha256sum -c suderra-agent_1.6.1_aarch64.tar.gz.sha256
```

**Expect:** digest matches.

**Verify:**
```bash
ls -l /var/lib/suderra/updates/
```

**On failure:** digest mismatch → the artefact is untrusted. Delete the staged files and request a re-issue. Never install an artefact that failed digest verification, even if the transport looked secure.

---

## Step 4 — Verify the manifest (software monotonic gate)

**Do:** today, verification runs through the closure-injected `verify_firmware_manifest` when Sprint 6.5 lands. For v1.6.0, run the out-of-band verification script shipped with the release to assert:

- Gate 1 — target arch matches (`TargetArch::compiled_target`, `src/updater/verify.rs:56-60`).
- Gate 5 — strict monotonic version (`manifest.version > highest_seen_firmware_version`).
- Gate 6 — freshness window `valid_from ≤ now ≤ valid_until`.
- Gate 8 — Ed25519 signature over canonical bytes. **Bypass today — ORPHAN-EDGE-004.** Sprint 6.5 wires this.

**Expect:** all gates pass; the expected new version is strictly greater than the currently installed version.

**Verify:**
```bash
/usr/local/bin/suderra-agent --version
cat /var/lib/suderra/updates/suderra-agent_1.6.1_aarch64.manifest.json | jq '.manifest.version'
```

**On failure:** monotonic violation → the candidate version is ≤ installed version. Anti-rollback policy refuses this. If a genuine rollback is required, follow `disaster-recovery.md` → "Rollback binary" (IRREVERSIBLE against anti-rollback counter once `tpm` feature is enabled).

---

## Step 5 — Extract and replace the binary

**Do:**
```bash
sudo tar --no-same-owner -xzf \
    /var/lib/suderra/updates/suderra-agent_1.6.1_aarch64.tar.gz \
    -C /var/lib/suderra/updates/extracted/

# Keep the previous binary for Rollback.
sudo mv /usr/local/bin/suderra-agent /usr/local/bin/suderra-agent.prev
sudo install -m 0755 -o root -g root \
    /var/lib/suderra/updates/extracted/suderra-agent \
    /usr/local/bin/suderra-agent
```

**Expect:** `/usr/local/bin/suderra-agent` is replaced; `/usr/local/bin/suderra-agent.prev` retains the previous version.

**Verify:**
```bash
file /usr/local/bin/suderra-agent
/usr/local/bin/suderra-agent --version   # the NEW version string
```

**On failure:** extract fails → disk full or permission error. Clear `/var/lib/suderra/updates/extracted/` and re-attempt; if disk is full, follow `backup-restore.md` cleanup steps before retry.

---

## Step 6 — Start and health-gate

**Do:**
```bash
sudo systemctl start suderra-agent

# Health gate: wait up to 60 s for /health to return 200.
for i in $(seq 1 60); do
    if curl -sf http://localhost:6526/health > /dev/null; then
        echo "healthy after ${i}s"
        break
    fi
    sleep 1
done
```

**Expect:** health within 60 s; journal shows a clean startup and MQTT reconnect.

**Verify:**
```bash
systemctl is-active suderra-agent
journalctl -u suderra-agent --since "2 min ago" | grep -iE 'started|ready|mqtt connected|error' | tail -20
```

**On failure:** health not ready → execute Rollback.

---

## Step 7 — Soak and confirm

**Do:** let the agent run for at least 10 min under normal load; watch for:

- Crash-looping (`NRestarts` > 1 in 10 min).
- Telemetry-lag alerts from the cloud.
- New ERROR-level journal entries.

**Expect:** none of the above.

**Verify:**
```bash
systemctl show suderra-agent -p NRestarts
journalctl -u suderra-agent --since "10 min ago" -p err --no-pager | head -20
```

**On failure:** any of the soak signals → execute Rollback.

---

## Step 8 — Record the new baseline

**Do:**
```bash
echo "$(date -u +%FT%TZ) upgrade $(/usr/local/bin/suderra-agent --version) operator=$(id -un)" \
    | sudo -u suderra tee -a /var/log/suderra/commissioning.log
# Once confident, remove the previous binary.
sudo rm -f /usr/local/bin/suderra-agent.prev
```

**Expect:** the commissioning log records the upgrade; `.prev` is removed after a successful soak.

**Verify:** `sudo -u suderra tail /var/log/suderra/commissioning.log`.

**On failure:** unable to write to `/var/log/suderra/` → the audit sink is compromised. Investigate before removing `.prev` — the Rollback depends on `.prev` being present.

---

## Post-conditions

- Running binary matches the new version.
- `/usr/local/bin/suderra-agent.prev` removed after soak.
- Commissioning log updated.
- Cloud side shows the new `agent_version` on the device capabilities retained message.

## Rollback

```bash
sudo systemctl stop suderra-agent
[ -x /usr/local/bin/suderra-agent.prev ] && \
    sudo install -m 0755 -o root -g root \
        /usr/local/bin/suderra-agent.prev /usr/local/bin/suderra-agent
sudo systemctl start suderra-agent
```

If `.prev` no longer exists (post-Step-8 cleanup), follow `disaster-recovery.md` → "Rollback binary from backup" which restores from the offline artefact archive.

## Appendix: Evidence

- `sens-api-gateway/src/updater/mod.rs:1-57` — module overview; firmware update flow summary; Sprint 6.5 wire-up scope.
- `sens-api-gateway/src/updater/verify.rs:1-60` — 8-gate ordered verify; closure-injected signature slot (ORPHAN-EDGE-004).
- `sens-api-gateway/src/updater/manifest.rs` — `SignedFirmwareManifest`, `FirmwareManifest`, `FileDigest`, `TargetArch`.
- `sens-api-gateway/src/updater/partition.rs` — `AbPartition`, `PartitionRoll`, `SlotState` types (Q4 roadmap: wire to bootloader flag).
- `sens-api-gateway/src/safe_state.rs:76-150` — `SafeStateManager::apply` invoked pre-shutdown.
- `sens-api-gateway/systemd/suderra-agent.service:38-56` — `WatchdogSec=60s` paired with 90 s ADR-019 cold-boot budget.
- `sens-api-gateway/Cargo.toml:355-392` — `signed-deploy`, `tpm`, `license-enforce` feature flags.
