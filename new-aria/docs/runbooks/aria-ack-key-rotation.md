# Runbook — ARIA Ack Ledger HMAC Key Rotation + Disaster Recovery

**Plan:** ARIA-V3 §A0 + §A5 + §2i (closes AUDITTRAIL-CRITICAL-001).
**Audience:** Operator + on-call engineer.
**Scope:** Key custody, scheduled rotation, emergency rotation, key loss, ledger integrity verification.

---

## 1. Key custody

The ack-ledger HMAC key lives at `aria-tools/secrets/ack_hmac.key` on the operator's local filesystem. The file:

- Is created on first `aria-kernel ack init` invocation.
- Has `chmod 0600` (operator-readable only).
- Is gitignored via `.gitignore` rule `aria-tools/secrets/` (verified by invariant `I-V3-19c`).
- Is NEVER committed to git history (verified by `I-V3-19d` `git log` scan).
- Contains a JSON document `{"keys": [{"key_id": "<uuid>", "secret": "<base64>", "minted_at": "<ts>", "retired_at": <ts|null>}, ...]}` with the rolling key list (most recent first).
- Retains the **last 5 keys** for historical signature verification (locked by `I-V3-19e`).

If `aria-tools/secrets/ack_hmac.key` does not exist, `aria-kernel ack init --reason <text> --operator-approval-ref <ref>` mints the first key and creates the file. The reason text is validated via `_validate_reason` (Plan ARIA-V2 §AUDITTRAIL-HIGH-005).

---

## 2. Scheduled rotation (every 90 days)

```bash
aria-kernel ack rotate-key \
  --reason "scheduled-90-day-rotation-cycle-$(date -u +%Y-Q%q)" \
  --operator-approval-ref RFC-XXXX
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
  --operator-approval-ref INC-XXXX \
  --emergency

# Step 2 — quarantine the previous key WITHOUT retaining it for verification
aria-kernel ack revoke-key \
  --key-id <leaked_key_id> \
  --reason "leaked-rotated-out" \
  --operator-approval-ref INC-XXXX
```

`--emergency` flag:

- Forces immediate rotation regardless of last-rotation-age throttle.
- Emits `ack_key_emergency_rotated` event (distinct from scheduled `ack_key_rotated`).
- Triggers a governance alert if observability webhook is configured.

`ack revoke-key`:

- Removes the named key from the rolling list **without** the standard retirement grace period.
- Any historical row signed by the revoked key becomes UNVERIFIABLE — but the row CONTENT remains (forensic value preserved); a `signed_key_revoked` annotation is appended to the row at verify-time.

---

## 4. Key loss / DR (key file deleted or corrupted)

If `aria-tools/secrets/ack_hmac.key` is lost:

1. **STOP**: any new `ack mint` will fail with `hmac_key_missing` until the key is regenerated. Do NOT regenerate silently — historical row verification is impacted.
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

| Invariant | What it locks |
|---|---|
| `I-V3-19c test_hmac_key_path_in_gitignore` | `.gitignore` covers `aria-tools/secrets/` |
| `I-V3-19d test_hmac_key_not_committed_to_git_history` | `git log` scan finds zero key-shaped commits |
| `I-V3-19e test_hmac_key_rotation_preserves_old_signature_verification` | Rolling list (last 5) verifies historical rows |
| `I-V3-19f test_dr_runbook_aria_ack_key_rotation_present` | This file exists at this path |

A failed invariant blocks the V3 invariant suite from passing; the kernel test sweep also blocks any PR landing on snowball until the invariant is restored.

---

## 7. Quick reference

| Action | Command |
|---|---|
| First-time init | `aria-kernel ack init --reason ... --operator-approval-ref ...` |
| Schedule rotation | `aria-kernel ack rotate-key --reason ... --operator-approval-ref ...` |
| Emergency rotation | `aria-kernel ack rotate-key --emergency --reason ...` |
| Revoke compromised key | `aria-kernel ack revoke-key --key-id ... --reason ...` |
| DR regenerate after loss | `aria-kernel ack init --force --reason ...` |
| Verify rows | `aria-kernel ack verify --range last-N|full` |
| List rolling keys | `aria-kernel ack list-keys` |

---

## 8. Auditor checklist

When auditing ack-ledger integrity:

1. Confirm `aria-tools/secrets/ack_hmac.key` exists, mode 0600, owner = operator.
2. Confirm `.gitignore` covers `aria-tools/secrets/`.
3. Confirm `git log --all --full-history -- aria-tools/secrets/` returns empty.
4. Run `aria-kernel ack verify --range full`; capture rows that fail.
5. For each failure row, look up `signed_key_id` in the rolling list AND in the revoked-key audit ledger; classify (rotated-out-grace-window vs revoked vs lost-key vs forged).
6. Cross-reference `ack_key_rotated` / `ack_key_emergency_rotated` / `ack_key_dr_regenerated` events with the operator's incident log.
7. Emit auditor decision row to `docs/reviews/aria/<date>-ack-key-audit.md`.
