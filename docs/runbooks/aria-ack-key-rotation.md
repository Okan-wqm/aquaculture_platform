# Runbook — ARIA Ack Ledger HMAC Key Rotation + Disaster Recovery

**Plan:** ARIA-V3 §A0 + §A5 + §2i (closes AUDITTRAIL-CRITICAL-001).
**Audience:** Operator + on-call engineer.
**Scope:** Key custody, scheduled rotation, emergency rotation, key loss, ledger integrity verification.

---

## 0. Operator acks are signed with the operator's key (ARIA-MEDIUM-254)

The HMAC key below does not sign operator acks. It lived under the store's untracked `secrets/`,
which `aria/state` never carries and every self-hosted job sweeps (`git clean -ffdx`) before the
store is restored, so an operator ack minted in one job never verified in a later one. An operator
ack is now the operator's own signed act, the same way `feedback request` is:

```bash
aria-kernel ack scope --draft-id <id> --kind agent          # read the body; note scope.body_sha256
aria-kernel ack mint --draft-id <id> --kind agent --body-sha256 <digest> \
  --reason "<why>" --operator-user-id <you> \
  --signing-key ~/.ssh/<operator-key> --signer-principal <principal> --actor-class T0 \
  --workspace-root <root-owned checkout on main>
```

- `ssh-keygen` signs the row as an `operator_ack` subject in the `aria-operator-request` namespace, with
  the actor class, the repository audience and an expiry (default and maximum: the namespace's 168 h).
  The subject is printed to stderr before `ssh-keygen` runs.
- The mint verifies the signature against `.github/manifests/aria-operator-signers` as committed at the
  checkout's commit proven on `main`, and writes nothing if it does not verify. Signing as root, the
  checkout, the working directory and the kernel package must be root-only (ARIA-LOW-266).
- Materialize verifies it again in whatever job runs it, against the checkout it is given
  (`--workspace-root`), and refuses an expired ack, a row no enrolled key signed, and any operator row
  minted with the HMAC key before this change (`operator_signature_required`: mint a new ack).
- `aria-kernel ack verify --workspace-root <checkout on main>` checks operator rows against the committed
  allowed-signers file and their consumption rows by their binding to the mint row on the hash-chained
  ledger; it needs no secret.

The rest of this runbook governs the HMAC key, which now signs only autonomous acks (minted and
consumed in one materialization; no live lane mints them) and the operator rows minted before
ARIA-MEDIUM-254.

## 1. Key custody

The ack-ledger HMAC key lives at `aria-tools/secrets/ack_hmac.key` on the operator's local filesystem. The file:

- Is created on first `aria-kernel ack init` invocation.
- Has `chmod 0600` (operator-readable only).
- Is gitignored via `.gitignore` rule `aria-tools/secrets/` (verified by invariant `I-V3-19c`).
- Is NEVER committed to git history (verified by `I-V3-19d` `git log` scan).
- Contains a JSON document with the rolling key list (most recent first) and, once a key has been
  revoked (§3), a `revoked` record list — ids and reasons only, never a secret:

  ```json
  {"keys": [{"key_id": "<uuid>", "secret": "<base64>", "minted_at": "<ts>", "retired_at": <ts|null>}, ...]}
  {"revoked": [{"key_id", "minted_at", "revoked_at", "reason"}, ...]}
  ```

- Retains the **last 5 keys** for historical signature verification (locked by `I-V3-19e`).

If `aria-tools/secrets/ack_hmac.key` does not exist, `aria-kernel ack init --reason <text>
--operator-approval-ref <gh-ref>` mints the first key and creates the file. The ref is the
operator's GitHub act (`ARIA-APPROVE surface=ack_key_operation operation=init`, posted by a
listed operator; ARIA-HIGH-238) — `aria-kernel operator approval-template` prints the line.
The reason text is validated via `_validate_reason` (Plan ARIA-V2 §AUDITTRAIL-HIGH-005).

---

## 2. Scheduled rotation (every 90 days)

```bash
# --operator-approval-ref is the operator's GitHub act approving
#   surface=ack_key_operation operation=rotate (ARIA-HIGH-238).
aria-kernel ack rotate-key \
  --reason "scheduled-90-day-rotation-cycle-$(date -u +%Y-Q%q)" \
  --operator-approval-ref gh:Okan-wqm/aquaculture_platform#1/comment/<id>
```

Effect:

1. Mints a new `key_id` with fresh secret.
2. Inserts the new key at position 0 (most recent).
3. Marks the previous head key as `retired_at: <ts>` (still valid for verification of historical rows).
4. If the rolling list now exceeds 5 entries, drops the oldest (its signature verification is permanently gone — any ledger rows signed with that key become unverifiable; rotation cadence MUST keep all relevant rows within the 5-key window).
5. Emits `ack_key_rotated` governance event with `old_key_id`, `new_key_id`, `operator_approval_ref`, `retired_keys[]`, `active_key_count`.
6. The next `ack mint` invocation signs with the new head key; rows persist `signed_key_id` so verification dispatches to the correct entry.

Validation:

```bash
aria-kernel ack verify --range last-50
# Reads the last 50 rows; for each, resolves signed_key_id against the
# rolling list and verifies HMAC. Exit 0 only if every row verifies.
```

---

## 3. Emergency rotation (suspected compromise)

If the key file leaks (e.g., committed accidentally, exposed in a backup, observed in logs):

```bash
# Step 1 — rotate immediately
aria-kernel ack rotate-key \
  --reason "emergency-rotation-suspected-leak-$(date -u +%FT%T)" \
  --operator-approval-ref gh:Okan-wqm/aquaculture_platform#1/comment/<id> \
  --emergency

# Step 2 — quarantine the previous key WITHOUT retaining it for verification
aria-kernel ack revoke-key \
  --key-id <leaked_key_id> \
  --reason "leaked-rotated-out" \
  --operator-approval-ref gh:Okan-wqm/aquaculture_platform#1/comment/<id>
```

`--emergency` flag:

- Forces immediate rotation regardless of last-rotation-age throttle.
- Emits `ack_key_emergency_rotated` event (distinct from scheduled `ack_key_rotated`).
- Triggers a governance alert if observability webhook is configured.

`ack revoke-key` (ARIA-LOW-598):

- Removes the named key from the rolling list **without** the standard retirement grace period: its
  secret is deleted from the key file at once, so a leaked copy can no longer produce a row that
  verifies.
- Keeps a revocation record (`key_id`, `minted_at`, `revoked_at`, `reason`) beside the list and emits
  an `ack_key_revoked` governance event with the `--operator-approval-ref`. No later rotation, init
  or DR regeneration drops the record; `ack list-keys` shows it under `revoked`.
- Refuses the current head key (`hmac_revoke_head_key`): rotate first (Step 1), then revoke the key
  that was the head. Refuses an id the rolling list does not hold and one already revoked.
- Any historical row signed by the revoked key becomes UNVERIFIABLE — but the row CONTENT remains
  (forensic value preserved): `ack verify` reports it as `signed_key_revoked`, never as valid and
  never as an unknown key.

---

## 4. Key loss / DR (key file deleted or corrupted)

If `aria-tools/secrets/ack_hmac.key` is lost:

1. **STOP**: any new autonomous ack will fail with `hmac_key_missing` until the key is
   regenerated (operator acks need no HMAC key, §0). Do NOT regenerate silently — historical row
   verification is impacted.
2. Run `aria-kernel ack verify --range full` BEFORE creating a new key — this records WHICH rows are currently verifiable (will be most of them, until step 3).
3. Mint a fresh key:
   ```bash
   aria-kernel ack init --force \
     --reason "DR-key-loss-recovery-$(date -u +%FT%T)" \
     --operator-approval-ref INC-XXXX
   ```
   `--force` flag is required when the key file already exists OR when the rolling list is non-empty but unreadable.
4. The kernel emits `ack_key_dr_regenerated` event with the verify-snapshot from step 2 attached. Historical rows are now UNVERIFIABLE (correct behavior — operator forensic record of the loss event).
5. New rows mint cleanly with the fresh key.

---

## 5. Cross-machine operator handoff

ARIA's ack key is per-clone by design (operator-local secret). To hand off the autonomous loop to a different machine:

1. Stop the autonomy daemon on the source machine: `aria-kernel autonomy stop --reason <text>`.
2. Wait for the cross-host lease to expire (lease TTL = 10 min from `aria-tools/locks/autonomous-host.lock`).
3. Copy `aria-tools/secrets/ack_hmac.key` to the destination machine via a secure channel (NOT via git, NOT via shared filesystem if multi-user).
4. On the destination machine: `chmod 0600 aria-tools/secrets/ack_hmac.key` (must already be set).
5. Run `aria-kernel ack verify --range last-100` on destination to confirm key validity.
6. Start the autonomy daemon on the destination machine: `aria-kernel autonomy run --profile autonomous`.

**Anti-pattern**: do NOT generate a new key on the destination machine while the source machine's key still mints rows — you will create two parallel signing keys with no precedence and historical verification will fork.

---

## 6. Verification invariants (CI-enforced)

| Invariant                                                              | What it locks                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `I-V3-19c test_hmac_key_path_in_gitignore`                             | `.gitignore` covers `aria-tools/secrets/`      |
| `I-V3-19d test_hmac_key_not_committed_to_git_history`                  | `git log` scan finds zero key-shaped commits   |
| `I-V3-19e test_hmac_key_rotation_preserves_old_signature_verification` | Rolling list (last 5) verifies historical rows |
| `I-V3-19f test_dr_runbook_aria_ack_key_rotation_present`               | This file exists at this path                  |
| `test_i_v3_00d_every_ack_command_the_runbook_prescribes_runs`          | Every `ack` command here parses (ARIA-LOW-598) |

A failed invariant blocks the V3 invariant suite from passing; the kernel test sweep also blocks any PR landing on snowball until the invariant is restored.

---

## 7. Quick reference

| Action                     | Command                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Operator ack (no HMAC key) | `aria-kernel ack mint ... --signing-key ... --signer-principal ... --actor-class T0` (§0)       |
| First-time init            | `aria-kernel ack init --reason ... --operator-approval-ref ...`                                 |
| Schedule rotation          | `aria-kernel ack rotate-key --reason ... --operator-approval-ref ...`                           |
| Emergency rotation         | `aria-kernel ack rotate-key --emergency --reason ... --operator-approval-ref ...`               |
| Revoke compromised key     | `aria-kernel ack revoke-key --key-id ... --reason ... --operator-approval-ref ...`              |
| DR regenerate after loss   | `aria-kernel ack init --force --reason ...`                                                     |
| Verify rows                | `aria-kernel ack verify --range last-N --workspace-root <checkout on main>` (or `--range full`) |
| List rolling keys          | `aria-kernel ack list-keys`                                                                     |

---

## 8. Auditor checklist

When auditing ack-ledger integrity:

1. Confirm `aria-tools/secrets/ack_hmac.key` exists, mode 0600, owner = operator.
2. Confirm `.gitignore` covers `aria-tools/secrets/`.
3. Confirm `git log --all --full-history -- aria-tools/secrets/` returns empty.
4. Run `aria-kernel ack verify --range full`; capture rows that fail.
5. For each failure row, look up `signed_key_id` in the rolling list AND in the revocation records
   (`aria-kernel ack list-keys` → `revoked`, and the `ack_key_revoked` governance events); classify
   (rotated-out-grace-window vs revoked vs lost-key vs forged). A revoked key's rows already verify
   as `signed_key_revoked`.
6. Cross-reference `ack_key_rotated` / `ack_key_emergency_rotated` / `ack_key_revoked` /
   `ack_key_dr_regenerated` events with the operator's incident log.
7. Emit auditor decision row to `docs/reviews/aria/<date>-ack-key-audit.md`.
