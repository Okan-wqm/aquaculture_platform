# Provisioning Runbook — bootstrap → activation → MQTT credentials

**Audience:** Field engineer at the device; plant IT operator at the cloud tenant-admin console.
**Prerequisites:**
- `install.md` Steps 1–7 complete; `suderra-agent` is running and emitting `NotActivated` in the journal.
- Operator has tenant-admin access to the cloud UI and can issue a single-use, time-bounded bootstrap token.
- Device has outbound HTTPS reachability to the provisioning API (`config.api_url`). For air-gapped sites, use `air-gapped.md` instead.
- Wall clock is correct (chrony `Leap status: Normal`). Activation rejects skewed requests.

**Duration:** 5–10 min.
**Blast radius:** single device.
**Safety:** no actuator is under agent control yet at provisioning time; no safe-state action is required.

---

## Honest roadmap disclosure (read before Step 1)

The v1.6.0 activation API (`src/provisioning.rs:111-125`) returns `mqtt_broker`, `mqtt_port`, `mqtt_username`, `mqtt_password` in the JSON body. The password is serialised into `config.yaml` under a `b64:` prefix + `Secret<String>` zeroize-on-drop wrapper (`src/config.rs:36-73`), with on-disk mode 0600 as the last line of defence.

**ORPHAN-EDGE-003:** the roadmap (Faz 2 Sprint 6.4) replaces this with a CSR-based flow where the edge submits a Certificate Signing Request and the cloud returns a client certificate — no shared MQTT password on the wire. Until then, operators must treat the activation response as a credential-bearing message and rotate MQTT credentials on cert revocation events.

---

## Step 1 — Mint a bootstrap token in the cloud tenant-admin UI

**Do:** sign in to the tenant-admin console with a role that has `device:provision` permission. Navigate to **Devices → Add device**. Fill:
- Device ID: leave blank if using **self-register** (tenant-level token); set to the desired UUID if using **activate** (device-level token).
- Token TTL: ≤ 15 min.
- Single-use: enabled.

**Expect:** the UI returns a token string (prefix typically `prov_`). Copy it now — the UI shows it once.

**Verify:** the token row in the UI audit log shows `issued_at`, `expires_at`, `used_at: null`.

**On failure:** token not displayed → check tenant-admin role permissions. Do not reissue more than one active token for the same device at the same time.

---

## Step 2 — Place the token on the device

**Do:** edit `/etc/suderra/config.yaml` on the device. Set either `provisioning_token` (device-level activation) **or** `tenant_token` (self-register). Do not set both:

```bash
# Device-level activation (device_id already known):
sudo sed -i 's|^device_id: .*|device_id: "00000000-0000-0000-0000-000000000000"|' \
    /etc/suderra/config.yaml
sudo tee -a /etc/suderra/config.yaml > /dev/null <<'EOF'
provisioning_token: "prov_PLACE_THE_TOKEN_HERE"
EOF

# OR, self-register (cloud allocates device_id):
sudo tee -a /etc/suderra/config.yaml > /dev/null <<'EOF'
tenant_token: "prov_TENANT_TOKEN_HERE"
EOF

# Secure perms again after any edit.
sudo chown root:suderra /etc/suderra/config.yaml
sudo chmod 0600 /etc/suderra/config.yaml
```

**Expect:** the token is stored under the canonical YAML keys. The agent reads both keys as `Secret<String>` (`src/config.rs:152-170`), so the token is zeroised from memory after activation succeeds and the post-activation save clears the token field.

**Verify:**
```bash
sudo -u suderra cat /etc/suderra/config.yaml | grep -E '(provisioning_token|tenant_token)' | head -1
```

**On failure:** file is world-readable → the helper at `src/security::validate_key_file_permissions` raises a validation error at load time. Re-apply `chmod 0600`.

---

## Step 3 — Trigger activation (SIGHUP or restart)

**Do:** reload config. The SIGHUP handler (`src/main.rs:795-876`) re-reads `config.yaml` and validates it under the write lock. If the agent detects an unactivated state with a token present, it runs the activation flow:

```bash
sudo systemctl reload suderra-agent
# equivalent: sudo systemctl kill -s HUP suderra-agent
```

**Expect:** journal shows
```
SIGHUP received — reloading configuration from disk...
Collecting device fingerprint...
Sending activation request to https://.../api/devices/activate
Activation successful for device <uuid>
```

**Verify:**
```bash
journalctl -u suderra-agent --since "2 min ago" \
    | grep -E 'Activation|Self.register|SIGHUP|NotActivated' | tail -15
```

**On failure:**
- `Activation failed: <code>` — map the code against `ActivationErrorCode` in `src/error.rs`. Common cases:
  - `TOKEN_EXPIRED` → token TTL elapsed; mint a new one (Step 1).
  - `TOKEN_ALREADY_USED` → single-use token consumed; mint a new one.
  - `FINGERPRINT_MISMATCH` → device fingerprint doesn't match the registered record. Check `machine-id`, `hostname`, NIC stability. If the device hardware legitimately changed, decommission the old device record first (see `disaster-recovery.md`).
- HTTP 5xx from cloud → check cloud provisioning-api health; retry with back-off (the agent does not auto-retry activation on startup; operator-driven).
- Redirect blocked (`reqwest::redirect::Policy::none()` in `src/provisioning.rs:221`) → verify `api_url` points directly at the provisioning API, not through an HTTP redirector. Cross-origin redirects are blocked to prevent token leakage.

---

## Step 4 — Confirm MQTT broker connection

**Do:**
```bash
journalctl -u suderra-agent --since "1 min ago" \
    | grep -iE 'mqtt|connected|subscribed' | head -20
```

**Expect:** within ~30 s of a successful activation the MQTT client connects with the credentials returned in the activation response. Typical trace:
```
MQTT broker = mqtt.example.com:8883 tls=true
MQTT connected
Subscribed to suderra/<tenant>/<device>/cmd/+ (QoS1)
Published capabilities to suderra/<tenant>/<device>/capabilities (retain=true)
```

**Verify:**
```bash
# From the cloud side (operator):
# - the device row shows "online" status
# - the capabilities topic has a retained message matching the device's features
```

**On failure:**
- MQTT TLS handshake fails → the activation response included `mqtt_tls_enabled=true` but the broker CA is not in the device trust store. Re-run with a CA bundle sourced from the activation response (roadmap Faz 2 — today the device uses the system CA store, which works for publicly-signed broker certs only).
- MQTT auth denied → password zeroized but not persisted. Restart the unit: `sudo systemctl restart suderra-agent`.
- Clean session mismatch → `config.mqtt.clean_session` default `false` preserves QoS 1/2 messages across reconnects (`src/config.rs:296-301`). Only flip `true` with operator awareness.

---

## Step 5 — Verify activation persists across reboot

**Do:**
```bash
sudo systemctl restart suderra-agent
journalctl -u suderra-agent --since "1 min ago" | grep -iE 'activated|mqtt' | head -10
```

**Expect:** on restart the agent reads the populated config and connects to MQTT without performing a second `activate` call. The `provisioning_token` / `tenant_token` field is absent from the saved config (post-activation save clears it).

**Verify:**
```bash
sudo -u suderra grep -E 'provisioning_token|tenant_token' /etc/suderra/config.yaml || echo "cleared"
```

**On failure:** token still present in the file → activation did not complete the post-success save. Check the journal for a save error (`src/config.rs::save()` enforces 0600 perms and fails on file-system error). Fix the underlying FS issue and re-run Step 3.

---

## Step 6 — Capture provisioning evidence

**Do:** record the following for the commissioning log:

```bash
sudo -u suderra awk '
/^device_id:/    {print}
/^device_code:/  {print}
/^tenant_id:/    {print}
/^api_url:/      {print}
' /etc/suderra/config.yaml | sudo tee -a /var/log/suderra/commissioning.log
```

**Expect:** non-empty `device_id`, `device_code`, `tenant_id`.

**Verify:** `/var/log/suderra/commissioning.log` contains the commissioning record; the tenant-admin UI shows `used_at` timestamp on the bootstrap token row.

**On failure:** missing `tenant_id` → activation response was accepted but persistence dropped a field. Inspect `journalctl -u suderra-agent` for serde errors around `ActivationResponse` fields (`src/provisioning.rs:111-125`).

---

## Post-conditions

- Agent is activated (`device_id`, `tenant_id`, MQTT credentials all present in `config.yaml`).
- Bootstrap token field is cleared from disk.
- MQTT broker session is established with TLS (unless the operator explicitly disabled `mqtt.tls.enabled`, which is not supported for production per `src/config.rs:223-261`).
- Capabilities topic carries a retained message matching the device's feature set.
- Commissioning evidence is written to `/var/log/suderra/commissioning.log`.

## Rollback

Provisioning is reversible by cloud-side revocation plus on-device credential wipe:

```bash
# 1. Cloud operator revokes the device certificate/credentials in the tenant-admin UI.
# 2. On the device:
sudo systemctl stop suderra-agent
sudo install -m 0600 -o root -g suderra /dev/null /etc/suderra/config.yaml
# Re-seed the minimal stub from install.md Step 6, then issue a fresh token.
```

Full decommission (with certificate revocation and secure-wipe) uses `uninstall.md`.

## Appendix: Evidence

- `sens-api-gateway/src/provisioning.rs:61-205` — `DeviceFingerprint` (MACs hashed per LOW-45), `ActivationRequest/Response`, `SelfRegisterRequest/Response`, redacted `Debug` impls.
- `sens-api-gateway/src/provisioning.rs:208-335` — `ProvisioningClient::activate` flow including redirect-policy lockdown.
- `sens-api-gateway/src/provisioning.rs:337-420` — `self_register` flow (tenant-level token).
- `sens-api-gateway/src/main.rs:722-887` — SIGHUP config reload (IEC 62443 FR5, SEC-010).
- `sens-api-gateway/src/config.rs:152-170` — `Secret<String>`-wrapped token fields, cleared after activation.
- ORPHAN-EDGE-003 — CSR flow ROADMAP Faz 2 Sprint 6.4.
