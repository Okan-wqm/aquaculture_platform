# Runbook: Edge Agent RBAC Manifest Push

Operational runbook for the RBAC manifest hot-reload flow
shipped by the Suderra edge agent in Sprint 6.1 (Batches
67-73). Covers first-boot manifest provisioning, hot-reload
via MQTT `update_policy`, emergency break-glass, and
rollback-protection posture.

## What the RBAC manifest is

A cloud-signed JSON document that binds operators (via
ed25519 public keys) to custom roles + custom roles to
permission sets. The edge agent loads the manifest at boot
and uses it as the source of truth for:

- **Envelope signature verification (Batch 68):** every
  signed MQTT command looks up the issuer's public key
  from `operator_bindings` via Gate 7.
- **Permission-gated command dispatch (Sprint 6.4
  activation):** role → permission lookup decides
  authorization.

The manifest is:

- ed25519-signed with the tenant's `rbac_manifest_signing_
  key` (separate from firmware + command signing keys per
  plan §3 R-4).
- Tenant-bound (embedded `tenant_id` MUST match the device's
  provisioned tenant).
- Version-monotonic (`policy_version` MUST exceed the
  persisted floor — Batch 71 rollback protection).

## Wire format

```json
{
  "manifest": {
    "version": 1,
    "policy_version": 42,
    "tenant_id": "fd23af6b-167f-4afd-a62a-ceace2a4046b",
    "manifest_valid_from_unix_secs": 1700000000,
    "manifest_valid_until_unix_secs": 1800000000,
    "operator_bindings": [
      {
        "operator_id": "00000000-0000-0000-0000-00000000abc1",
        "pubkey": [32 bytes hex],
        "role_names": ["operator", "maintenance"]
      }
    ],
    "roles": [
      {
        "name": "operator",
        "permissions": ["ReadTag", { "WriteTag": { "tag_id": "..." } }],
        "valid_from_unix_secs": 1700000000,
        "valid_until_unix_secs": 1800000000,
        "is_emergency_role": false
      }
    ]
  },
  "signature": [64 bytes ed25519]
}
```

## First-boot provisioning

**Prerequisite:** device is provisioned to a tenant;
tenant has a generated `rbac_manifest_signing_key`.

### Step 1 — generate the manifest

Platform UI: Fleet → Tenant → RBAC → Generate Manifest.
The platform:
1. Assembles operator bindings + roles from the tenant's
   RBAC state.
2. Assigns a monotonic `policy_version` (greater than any
   previously signed for this tenant).
3. Signs with the tenant's key.
4. Exports `rbac_manifest.json`.

### Step 2 — deploy to device

```bash
scp rbac_manifest.json suderra@<device>:/tmp/
ssh suderra@<device> bash -s <<'EOF'
set -euo pipefail
sudo mv /tmp/rbac_manifest.json /etc/suderra/
sudo chown suderra:suderra /etc/suderra/rbac_manifest.json
sudo chmod 0440 /etc/suderra/rbac_manifest.json
EOF
```

### Step 3 — configure + restart

`/etc/suderra/config.yaml`:

```yaml
rbac_manifest:
  mode: permissive           # Disabled | Permissive | Enforcing
  manifest_signing_pubkey_hex: <64-char hex ed25519 pubkey>
  # manifest_path defaults to /etc/suderra/rbac_manifest.json
  # version_store_path defaults to /var/lib/suderra/rbac_version.sqlite
```

Recommended rollout sequence:
1. **Disabled** (HC-1 default) — envelope signature verify
   falls to NO-OP; legacy unsigned commands accepted.
2. **Permissive** — manifest loaded + signature verify
   runs; verify FAILURE logs but doesn't reject (early-
   detection for cloud signer issues).
3. **Enforcing** — verify failure REJECTS the command.

Always test in Permissive for ≥ 7 days before flipping to
Enforcing. Monitor `audit.log` for
`action: policy_update_rejected` or Gate-7 rejection counts.

### Step 4 — verify load

```bash
sudo systemctl restart suderra-agent
sudo journalctl -u suderra-agent | grep -i "RBAC manifest"
# Expect: "RBAC manifest verified: policy_version=42 operator_count=N role_count=M"
# Also:   "RBAC manifest floor advanced: policy_version=42 persisted_floor=42"
```

## Hot-reload via MQTT `update_policy`

Once the device is running in Permissive/Enforcing mode,
manifests can be rotated WITHOUT agent restart (Batch 72
Sprint 6.1).

### Step 1 — generate new manifest

Same as first-boot Step 1, BUT the new `policy_version`
MUST strictly exceed the currently-persisted floor (check
via `cmd_get_config` — returned `rbac_manifest.policy_
version`). Manifests with `policy_version <= floor` are
rejected as rollback attempts.

### Step 2 — sign the MQTT command

The `update_policy` command itself requires a valid
CommandEnvelope per Batch 68 Gate-7 signature verify AND
gates on `Permission::ManagePolicy` per Batch 72
required_permission table. The operator invoking the rotate
MUST have ManagePolicy in a role currently bound to their
public key.

Via Suderra platform UI: Fleet → Device → Policy →
Rotate Manifest. The platform:
1. Verifies the operator has ManagePolicy.
2. Constructs the CommandEnvelope with:
   - `cmd: "update_policy"`
   - `params: { "signed_manifest": { ...new manifest... } }`
   - `tenant_id`, `iat`, `exp`, `jti`, `nonce`, `cmd_hash`.
3. Signs with the operator's private key.
4. Publishes to `tenants/<tid>/devices/<did>/cmd`.

### Step 3 — edge handler flow

On receipt:
1. Envelope Gate 1-6 (tenant, freshness, jti dedup, etc.).
2. Gate 7 (signature verify via Batch 68 lookup from
   CURRENT manifest).
3. Dispatch to `cmd_update_policy`.
4. Permission check: actor has ManagePolicy?
5. `RbacManifestStore::hot_reload_from_bytes`:
   a. Shared `verify_and_floor` (signature + tenant +
      version monotonicity against persistent floor).
   b. UPSERT `MAX(existing_floor, new_version)` in
      `rbac_version.sqlite`.
   c. Atomic in-memory swap via RwLock write-guard.
   d. Atomic disk persist (tempfile + rename) so next
      restart loads the new manifest.
6. Return `{ policy_version, operator_count, role_count }`.

### Step 4 — verify rotation

```bash
# From the edge device:
sudo journalctl -u suderra-agent | tail -20 | grep -i "hot-reload"
# Expect: "RBAC manifest hot-reloaded: policy_version=43 persisted=/etc/suderra/rbac_manifest.json"

# Confirm floor advanced:
sudo sqlite3 /var/lib/suderra/rbac_version.sqlite \
  "SELECT highest_seen FROM rbac_manifest_version;"
# Expect: 43 (the new version)
```

## Emergency break-glass

**Status:** Phase 2 / Batch 88+ work per plan §3.1 R-5 +
ADR-018 §8. Not yet wired.

**Planned path:** `/etc/suderra/emergency_policy.json.sig`
on a read-only partition, manufacturer-signed (separate
key from tenant's operator keys). Invoked via SIGUSR2 or
a specific envelope command; overrides the live manifest
with emergency roles (operator_id + time-bounded
Permission::EmergencyOverride).

Until Batch 88 ships, the manual workaround is:
1. SSH to the device as `suderra` user.
2. `sudo systemctl stop suderra-agent`.
3. Replace `/etc/suderra/rbac_manifest.json` with a
   pre-signed emergency manifest.
4. `sudo sqlite3 /var/lib/suderra/rbac_version.sqlite
   "DELETE FROM rbac_manifest_version;"` to reset the
   floor (the emergency manifest's policy_version must
   exceed the previous floor, OR reset to accept any
   version).
5. `sudo systemctl start suderra-agent`.

This workaround is NOT tamper-evident. Audit via
`edge-audit-forensics.md`.

## Rollback-protection posture (Batch 71)

The persistent version floor at
`/var/lib/suderra/rbac_version.sqlite` is SQLCipher-encrypted
(via the offline_queue derivation helper). An attacker with
filesystem write access CANNOT flip the floor to zero
without also compromising the machine-id-derived encryption
key.

Boot-time fail-closed: if the floor store fails to open in
Enforcing mode, the agent exits(1). Permissive mode
warn-logs + continues with an in-memory floor=0 (rollback
window open for that boot).

## Configuration reference

```yaml
rbac_manifest:
  # Disabled | Permissive | Enforcing
  mode: permissive

  # REQUIRED when mode != Disabled.
  manifest_signing_pubkey_hex: <64 chars lowercase hex>

  # Defaults:
  #   manifest_path:         /etc/suderra/rbac_manifest.json
  #   version_store_path:    /var/lib/suderra/rbac_version.sqlite
  manifest_path: /etc/suderra/rbac_manifest.json
  version_store_path: /var/lib/suderra/rbac_version.sqlite
```

## Troubleshooting

### "RBAC manifest load FAILED: TenantMismatch"

**Cause:** the manifest's `tenant_id` doesn't match the
device's provisioned tenant.

**Fix:** re-generate the manifest from the CORRECT tenant
in the platform UI. Each device is bound to exactly one
tenant; manifests are NOT portable across tenants.

### "RBAC manifest load FAILED: InvalidSignature"

**Cause:** the `manifest_signing_pubkey_hex` config value
doesn't match the tenant's actual signing key, OR the
manifest was generated with a rotated-out key.

**Fix:** verify the configured pubkey matches the current
tenant `rbac_manifest_signing_key.public`. If tenant rotated
the signing key, update config + restart.

### "RBAC manifest load FAILED: PolicyVersionStale"

**Cause:** attempted rollback — new manifest's
`policy_version ≤ persisted_floor`.

**Fix:** if legitimate rollback is needed (rare, e.g.
compromised-manifest revert), use the manual workaround
in "Emergency break-glass" to reset the floor + deploy.

### Hot-reload command silently rejected

Check:
1. Operator has `Permission::ManagePolicy` in a currently-
   bound role.
2. Envelope signature verifies against the CURRENT
   manifest (chicken-egg: the OLD manifest is what
   authenticates the NEW manifest's rotator).
3. `rbac_manifest.mode` is `Permissive` or `Enforcing`
   (Disabled rejects hot-reload with structured error).

## Related runbooks

- `edge-audit-forensics.md` — audit log verification.
- `edge-keystore-operations.md` — keystore provisioning +
  rotation (the RBAC manifest signing key and the keystore
  master are SEPARATE trust anchors).
