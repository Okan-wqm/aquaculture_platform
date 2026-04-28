# Runbook: Edge Agent Keystore Operations

Operational runbook for the master-key keystore shipped by
the Suderra edge agent (`sens-api-gateway`) in Sprint 6.3
(Batches 82-84). Covers first-boot provisioning, key
rotation, compromise response, and backend selection.

## Backends (ADR-018 §4 priority order)

| Priority | Backend | When used | Security tier |
|---|---|---|---|
| 1 (preferred) | **TPM** | RPi CM4/5 with TPM2 OR external TPM | Hardware-backed NV-sealed, PCR-bound |
| 2 | **systemd-creds** | Linux with systemd ≥ 250 | TPM-backed at systemd abstraction |
| 3 (fallback) | **FileBacked** | Dev/test OR TPM-unavailable | Argon2id passphrase + salt |

Current Sprint 6.3 status:
- Batch 82: FileBacked **landed + tested (12/12 green)**.
- Batch 83a: TPM backend — pending.
- Batch 83b: systemd-creds backend — pending.

Until TPM + systemd-creds ship, `keystore.mode = auto` falls
through to FileBacked after logging the downgrade. Operators
wanting hardware-backed security should wait for Batch 83a.

## First-boot provisioning (FileBacked)

**Prerequisite:** the operator has signed an acceptance
token via the Suderra platform ceremony, because
FileBacked is explicitly less secure than TPM and requires
documented operator consent per ADR-018 §5.

### Step 1 — generate passphrase + salt

On a SECURE workstation (not the edge device; the
passphrase never touches public networks):

```bash
# Passphrase: at least 32 bytes of high-entropy random.
openssl rand -base64 48 > keystore.passphrase

# Salt: 16 bytes random.
openssl rand 16 > keystore.salt
```

### Step 2 — sign acceptance token

Use the Suderra platform UI: Fleet → Device → Generate
File-Backed Keystore Acceptance. The token includes:
- `operator_id` (the signing operator's ID).
- `device_id` (the target device's provisioning ID).
- `expires_at_unix_secs` (default 90 days per ADR-018 §5;
  after expiry the agent refuses to open FileBacked and
  halts — force operator to re-sign OR provision TPM).
- ed25519 signature over the above + domain-separation tag.

Download as `keystore.acceptance.json`.

### Step 3 — copy to edge device with correct permissions

```bash
# On the edge device, via secure transport (SSH with cert):
scp keystore.passphrase keystore.salt keystore.acceptance.json \
  suderra@<device>:/tmp/

ssh suderra@<device> bash -s <<'EOF'
set -euo pipefail
sudo mkdir -p /etc/suderra
sudo mv /tmp/keystore.passphrase /etc/suderra/
sudo mv /tmp/keystore.salt /etc/suderra/
sudo mv /tmp/keystore.acceptance.json /etc/suderra/
sudo chown suderra:suderra /etc/suderra/keystore.*
sudo chmod 0400 /etc/suderra/keystore.passphrase
sudo chmod 0400 /etc/suderra/keystore.salt
sudo chmod 0440 /etc/suderra/keystore.acceptance.json
EOF
```

### Step 4 — configure + restart

Edit `/etc/suderra/config.yaml`:

```yaml
keystore:
  mode: auto         # falls through to FileBacked pre-TPM
  argon2_memory_kib: 65536   # 64 MiB, ADR-018 §5 default
  argon2_iterations: 3
  argon2_parallelism: 4
```

Restart the agent:

```bash
sudo systemctl restart suderra-agent
sudo journalctl -u suderra-agent -f | grep -i keystore
# Expect: "Keystore opened: backend=FileBacked argon2id m=65536KiB t=3 p=4"
```

### Step 5 — verify downstream derivation

The audit sink + SQLCipher DBs consume keystore-derived
keys via `KeyPurpose::*`. Verify:

```bash
# Audit sink migrated to keystore-derived (Batch 84):
sudo journalctl -u suderra-agent | grep "Audit HMAC key"
# Expect: "Audit HMAC key: derived from keystore ..."
```

## Key rotation

**Current state (Sprint 6.3):** live rotation via MQTT
`rotate_master` command is tracked as Phase 2 / Batch 85
work. Pre-Batch-85 rotation requires agent restart with
new passphrase.

### Scheduled rotation (180-day default per ADR-018 §6)

Until Batch 85 ships:

```bash
# On the secure workstation:
openssl rand -base64 48 > keystore.passphrase.new
openssl rand 16 > keystore.salt.new

# Generate a fresh acceptance token (platform UI).

# On edge device (via SSH):
sudo systemctl stop suderra-agent
sudo mv /etc/suderra/keystore.passphrase{.new,}
sudo mv /etc/suderra/keystore.salt{.new,}
sudo mv /etc/suderra/keystore.acceptance.json.new /etc/suderra/keystore.acceptance.json
sudo chmod 0400 /etc/suderra/keystore.passphrase
sudo chmod 0400 /etc/suderra/keystore.salt
sudo chmod 0440 /etc/suderra/keystore.acceptance.json
sudo systemctl start suderra-agent
```

**Caveat:** rotating the master invalidates ALL derived
keys. The audit HMAC chain has a pre-rotation segment + a
post-rotation segment that cannot be verified with the
same key. Preserve a SNAPSHOT of the log BEFORE rotation +
the OLD derived key for retroactive verify. Batch 85 will
add rotation-aware chain stitching.

### Compromise response (zero-notice)

If the master is KNOWN compromised (passphrase leak, device
loss):

1. **Immediate:** rotate firmware-signing keys via platform
   ceremony (independent trust anchor).
2. **Immediate:** rotate RBAC manifest-signing key (forces
   re-issue of all manifests).
3. **Device-scope:** remote wipe if device is still
   reachable; if not, treat as compromised and revoke its
   cert at the MQTT broker.
4. **Rotate master** on each surviving device per the
   scheduled-rotation procedure above.
5. **Audit retention:** preserve compromised-period audit
   logs for forensic analysis (regulatory retention ≥ 7
   years per plan §2 HC-12).

## Configuration reference

```yaml
keystore:
  # Disabled | Auto | FileBacked
  mode: auto

  # FileBacked paths (None defaults to /etc/suderra/keystore.*)
  passphrase_path: /etc/suderra/keystore.passphrase
  salt_path: /etc/suderra/keystore.salt
  acceptance_path: /etc/suderra/keystore.acceptance.json

  # Argon2id params (OWASP 2024 floor enforced by Rule 18)
  argon2_memory_kib: 65536   # 64 MiB, ≥ 19456
  argon2_iterations: 3       # ≥ 2
  argon2_parallelism: 4      # ≥ 1
```

## Troubleshooting

### Boot-time fail-closed

`Keystore init failed (fail-closed boot): ...`

Most common causes:

| Error suffix | Cause | Fix |
|---|---|---|
| `read passphrase ... No such file` | passphrase file missing at configured path | Copy the file with 0400 perms |
| `read acceptance ... Permission denied` | agent user can't read acceptance | `chown suderra:suderra` |
| `passphrase file ... is empty` | zero-byte passphrase | Regenerate + redeploy |
| `salt file ... has N bytes, Argon2id requires >= 16` | salt too short | Regenerate via `openssl rand 16` |
| `acceptance token invalid: Expired` | 90-day acceptance elapsed | Re-sign via platform UI |
| `argon2_memory_kib=... below OWASP 2024 floor` | config Argon2id params below OWASP | Raise to ≥ 19456 |

### Audit sink falls back to config hex

Log line: `Audit HMAC key: using config.audit.hmac_key_hex
rollout-stage path`.

**Cause:** keystore.mode=Disabled — audit sink uses the
config hex key source. Intentional for pre-rollout
deployments.

**Fix:** set `keystore.mode: auto` (or `file_backed`) +
provision the keystore files per Step 3 above.

## Related runbooks

- `edge-audit-forensics.md` — audit log verification.
- `edge-rbac-manifest-push.md` — policy push via MQTT.
