# Install Runbook — `suderra-agent` v1.6.0

**Audience:** Field engineer with root access on the target device.
**Prerequisites:**
- Supported hardware: Raspberry Pi 4 (≥4 GB RAM) / Raspberry Pi 5 / Revolution Pi Connect 4 / x86 SIMATIC IPC (227E/427E/477E) / SIMATIC IOT2050.
- SD card Class 10 or eMMC ≥32 GB.
- TPM 2.0 module present and enumerated under `/dev/tpmrm0` — preferred, not required (see ADR-018 §7 graceful-fallback tiers).
- Network egress to the provisioning API HTTPS endpoint is reachable (or the air-gapped runbook is in effect — see `air-gapped.md`).
- Signed firmware artefact `suderra-agent_<version>_<arch>.tar.gz` + detached Ed25519 signature from the release pipeline. Do not install unsigned binaries.

**Duration:** 20–40 min on first flash; 5–10 min for binary upgrade.
**Blast radius:** single device.
**Safety:** no actuator is wired to the agent yet at install time. If this device is replacing an already-wired agent, `SafeStateManager::apply` must be invoked through the replaced agent first (`src/safe_state.rs:123`) — see `uninstall.md` Step 2 before wiring this one.

---

## Step 1 — Prepare the base OS

**Do:**
```bash
# Raspberry Pi 4 / 5: flash Raspberry Pi OS 64-bit (Debian 12 based)
# RevPi Connect 4: vendor image already ships Debian 12 (bookworm)
# x86 SIMATIC IPC: install Debian 12 minimal (no desktop)
uname -m              # aarch64 for RPi / RevPi / IOT2050; x86_64 for IPC
cat /etc/os-release   # PRETTY_NAME should be "Debian GNU/Linux 12 (bookworm)"
                      # or "Raspberry Pi OS" (bookworm-based)
```

**Expect:** arch matches the hardware matrix in `README.md`; Debian 12 / Raspberry Pi OS 64-bit bookworm.

**Verify:**
```bash
apt list --installed 2>/dev/null | grep -E '^(linux-image|raspberrypi-kernel)' | head -1
```
Kernel must be ≥6.1 (bookworm baseline).

**On failure:** re-flash with the correct 64-bit image. 32-bit armv7 is not supported — the agent does not publish armv7 builds.

---

## Step 2 — Create dedicated system user and directories

**Do:**
```bash
sudo useradd -r -s /usr/sbin/nologin suderra
sudo install -d -o suderra -g suderra -m 0750 /var/lib/suderra
sudo install -d -o suderra -g suderra -m 0750 /var/log/suderra
sudo install -d -o root     -g suderra -m 0750 /etc/suderra
```

**Expect:** the directory tree exists with the exact modes + ownerships above. `/etc/suderra` is root-owned because the service unit mounts it `ReadOnlyPaths=` (see `systemd/suderra-agent.service:95`).

**Verify:**
```bash
id suderra
stat -c '%U:%G %a %n' /var/lib/suderra /var/log/suderra /etc/suderra
```

Expected output:
```
suderra:suderra 750 /var/lib/suderra
suderra:suderra 750 /var/log/suderra
root:suderra 750 /etc/suderra
```

**On failure:** fix the ownership / mode — the systemd unit will refuse to write outside the declared `ReadWritePaths` (`suderra-agent.service:94`). A drifted mode yields `EACCES` on first boot with no recovery path.

---

## Step 3 — Install platform dependencies

**Do:**
```bash
# Mandatory on every target
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
    ca-certificates \
    chrony \
    systemd

# Optional — only when the `tpm` Cargo feature is enabled in the binary
sudo apt-get install -y --no-install-recommends libtss2-esys-3.0.2-0

# Optional — only when cross-compiling on this device (not recommended for field install)
sudo apt-get install -y --no-install-recommends libsqlite3-dev
```

**Expect:** the agent binary is statically linked except for `libtss2-esys` (TPM), `libc`, and the system `ca-certificates` bundle. No further runtime libraries are needed for the default build.

**Verify:**
```bash
dpkg -s chrony | grep Status  # Status: install ok installed
systemctl is-active chrony    # active
```

Clock sync (chrony) is load-bearing: firmware manifest freshness (`src/updater/verify.rs:55-60`) and audit timestamps (ADR-020) assume a correct wall clock.

**On failure:** until chrony reports `Leap status: Normal` via `chronyc tracking`, do not proceed. Provisioning will reject clock-skewed requests.

---

## Step 4 — Install the agent binary

**Do:**
```bash
# Copy the signed artefact to the device via your preferred secure channel (scp, USB).
# Verify signature BEFORE extraction.
cd /tmp
sha256sum -c suderra-agent_1.6.0_aarch64.tar.gz.sha256
# If a detached signature and public key are provided:
#   openssl dgst -sha256 -verify <release-pubkey.pem> \
#       -signature suderra-agent_1.6.0_aarch64.tar.gz.sig \
#       suderra-agent_1.6.0_aarch64.tar.gz

sudo tar --no-same-owner -xzf suderra-agent_1.6.0_aarch64.tar.gz -C /tmp/suderra-install
sudo install -m 0755 -o root -g root /tmp/suderra-install/suderra-agent /usr/local/bin/suderra-agent
```

**Expect:** `/usr/local/bin/suderra-agent` is 0755, root-owned, executable. File magic is `ELF 64-bit LSB executable`.

**Verify:**
```bash
file /usr/local/bin/suderra-agent
/usr/local/bin/suderra-agent --version
```

**On failure:**
- Signature mismatch → the artefact is untrusted. Delete `/tmp/suderra-agent*` and request a re-issue from the release pipeline. Never install an unverified binary.
- `--version` crash → the binary was built for the wrong arch. Re-check `uname -m` matches the tarball arch suffix.

---

## Step 5 — Install the systemd unit

**Do:**
```bash
sudo install -m 0644 -o root -g root \
    sens-api-gateway/systemd/suderra-agent.service \
    /etc/systemd/system/suderra-agent.service
sudo systemctl daemon-reload
```

**Expect:** `systemctl cat suderra-agent` echoes the unit with `ProtectSystem=strict`, `MemoryDenyWriteExecute=true`, `LimitCORE=0`, `WatchdogSec=60s`. These directives are load-bearing for IEC 62443 SL-2 FR3/FR4 (`systemd/suderra-agent.service:35-140`).

**Verify:**
```bash
systemd-analyze security suderra-agent
```

Expected: `Overall exposure level for suderra-agent.service: <X>` with the row-by-row view showing the hardening directives are active. Target exposure level: **SAFE** or tighter.

**On failure:** if the analyser reports `UNSAFE`, a directive is missing. Do NOT patch the unit file inline — re-copy the repo's canonical file. Drift here is an architectural defect.

---

## Step 6 — Place an unactivated `config.yaml`

**Do:**
```bash
sudo install -m 0600 -o root -g suderra /dev/null /etc/suderra/config.yaml
cat <<'EOF' | sudo tee /etc/suderra/config.yaml > /dev/null
device_id: ""
device_code: ""
api_url: "https://provisioning.example.com"
mqtt:
  broker: null
  port: 8883
  username: null
  password: null
  tls:
    enabled: true
    verify_hostname: true
  topics: {}
EOF
sudo chmod 0600 /etc/suderra/config.yaml
sudo chown root:suderra /etc/suderra/config.yaml
```

**Expect:** a minimal config that is not yet activated. Provisioning will populate `device_id`, MQTT credentials, and `tenant_id`. The file is mode 0600 because it eventually holds the `mqtt_password` today (see `src/config.rs:277-283` — `Secret<String>` zeroize-on-drop + `b64:` prefix). On-disk 0600 is the last line of defence; the agent already encodes the field and zeroises in memory.

**Verify:**
```bash
stat -c '%U:%G %a %n' /etc/suderra/config.yaml
# root:suderra 600 /etc/suderra/config.yaml
```

**On failure:** mode drift → `chmod 0600 /etc/suderra/config.yaml && chown root:suderra /etc/suderra/config.yaml`. The validation happens inside the agent on `load()` (`src/config.rs:141`) and on the Unix private-key permission helper (`src/security`, MED-23).

---

## Step 7 — Enable and start the service

**Do:**
```bash
sudo systemctl enable suderra-agent.service
sudo systemctl start suderra-agent.service
```

**Expect:** unit state becomes `active (running)`. On a fresh install without activation, the agent enters the provisioning wait loop and emits `NotActivated` log records; it does not crash.

**Verify:**
```bash
systemctl is-active suderra-agent
systemctl show suderra-agent -p WatchdogUSec,LimitCORE,MemoryMax
journalctl -u suderra-agent --since "5 min ago" | tail -20
```

Expected directive values:
- `WatchdogUSec=1min` (60 s)
- `LimitCORE=0`
- `MemoryMax=268435456` (256 MiB)

**On failure:**
- `active (exited)` within 60 s → inspect journal for validation errors. The first boot expects the stub `config.yaml` from Step 6; a malformed config rejects here before any network I/O.
- OOM / memory kill → check whether another service is already consuming the 256 MiB budget declared in the unit (`MemoryMax=256M`). Do not raise the budget to make the error disappear — identify the real consumer.

---

## Step 8 — (x86 SIMATIC IPC only) Initial hardening profile

**Do:**
```bash
# Disable console login on serial tty that the plant operator never uses
sudo systemctl disable --now serial-getty@ttyS0.service 2>/dev/null || true

# Ensure the machine is in UEFI Secure Boot with Siemens-signed shim
mokutil --sb-state   # expect: SecureBoot enabled
```

**Expect:** Secure Boot is enabled; serial console login is disabled (BIOS-level console is retained for rescue).

**Verify:**
```bash
mokutil --sb-state
systemctl is-enabled serial-getty@ttyS0.service 2>/dev/null || echo "disabled or absent"
```

**On failure:** if Secure Boot reports disabled on a SIMATIC IPC, return to BIOS and enable it. This is the Initial hardening profile baseline — subsequent `ota-firmware-update.md` anti-rollback guarantees depend on it.

---

## Post-conditions

- `/usr/local/bin/suderra-agent` is installed, signature-verified, executable.
- `suderra` user + `/etc/suderra`, `/var/lib/suderra`, `/var/log/suderra` directory tree exists with canonical modes.
- `suderra-agent.service` is enabled, active, and the `systemd-analyze security` result is SAFE or tighter.
- Chrony is active; the wall clock is trusted.
- `/etc/suderra/config.yaml` exists mode 0600, holding a minimal unactivated stub.
- The device is ready for `provisioning.md`.

## Rollback

```bash
sudo systemctl disable --now suderra-agent.service
sudo rm -f /etc/systemd/system/suderra-agent.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/suderra-agent
# Leave /etc/suderra, /var/lib/suderra in place for troubleshooting.
# To fully remove state see `uninstall.md` (IRREVERSIBLE).
```

## Appendix: Evidence

- `sens-api-gateway/systemd/suderra-agent.service:1-189` — full hardened unit.
- `sens-api-gateway/src/config.rs:141` — `DEFAULT_CONFIG_PATH = "/etc/suderra/config.yaml"`.
- `sens-api-gateway/src/config.rs:277-283` — MQTT password `Secret<String>` + zeroize-on-drop.
- `sens-api-gateway/Cargo.toml:317-397` — feature flag catalogue; default build enables no security feature that changes posture silently (invariant `tests/invariants/default_build_no_security_escape.rs`).
