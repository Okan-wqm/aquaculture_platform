# Runbook: KVKK Breach Notification

**Referenced by**: Plan v3 R37 + ADR-022 (pseudonymisation key
management) + ADR-024 (compliance retention matrix).

**Purpose**: KVKK (Law 6698) Article 12.5 requires the data
controller to notify the Turkish Personal Data Protection Authority
(KVKK Kurumu) within **72 hours** of becoming aware of a personal
data breach affecting Turkish data subjects.

This runbook is the operator-side playbook executed when a
reportable breach is confirmed.

---

## Reporting thresholds

KVKK notification is REQUIRED when:

- Personal data of Turkish data subjects is accessed by an
  unauthorised party (including internal users acting outside
  scope).
- Encrypted data is exposed AND the decryption key is simultaneously
  compromised.
- Pseudonymised data is linked back to an identifiable person
  (e.g. `TENANT_HASH_PEPPER` compromise).

NOT reportable (but still tracked internally per SOC2):

- Access attempts blocked by the access-control layer (no
  exfiltration).
- Drift / audit warnings without evidence of data egress.

## Timeline

| When             | Action                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| T+0            | Incident declared. On-call engineer + Security Lead + Legal notified.  |
| T+0 to T+2h    | Scope assessment — which tenants, which fields, how many rows.         |
| T+2h to T+24h  | Containment: rotate keys, revoke sessions, `aqua-ctl drift-bypass`     |
|                  | lifted once containment stable.                                        |
| T+24h to T+72h | Draft notification. Legal review. Submit to KVKK Kurumu.               |
| T+72h          | **Hard deadline for KVKK submission.**                                 |
| T+7d           | Data subject communication (if individually identifiable).             |
| T+30d          | Post-incident review. Retention-matrix + ADR updates if applicable.    |

## Containment checklist

- [ ] Rotate `TENANT_HASH_PEPPER` (ADR-022) — invalidates all
      prior `tenant_id_hash` values; re-hash audit trails via the
      scheduled recompute job.
- [ ] Rotate every `keyId` for `@EncryptedAtRest` columns whose
      ciphertext may have leaked (docs/runbooks/encrypted-column-
      key-rotation.md).
- [ ] Revoke JWT signing keys; force re-authentication.
- [ ] Revoke NATS client certs for any service in the blast radius;
      re-mint via `scripts/nats/generate-nats-conf.py`.
- [ ] Rotate Spaces access keys; invalidate Spaces tokens in Vault.
- [ ] Preserve audit evidence: snapshot
      `observability.migration_events`, `observability.schema_object_
      history`, `observability.emergency_overrides`, and
      `docs/reviews/_registry/findings.jsonl` to the immutable legal
      hold bucket at the TIME of confirmation (retention 7 years per
      ADR-024).

## KVKK submission content

- Data controller (Veri Sorumlusu) identification (see
  `docs/compliance/kvkk-veri-sorumlusu.md`).
- Breach type + timeline.
- Affected data categories + approximate record count.
- Likely consequences.
- Measures taken + proposed.
- Contact point for follow-up.

## Post-incident

- Attestation markdown at `docs/compliance/evidence/<incident-id>.md`
  per plan v3 R38 (compliance-attestation-coverage gate).
- Update the retention matrix or ADR if the incident surfaced a
  gap. ADR changes go through CODEOWNERS review per
  `tools/gates/migration-codeowners-coverage.ts` pattern.

## References

- KVKK Law 6698 Article 12.5
- ADR-022 Pseudonymisation Key Management
- ADR-024 Compliance Retention Matrix
- docs/compliance/README.md
- docs/runbooks/encrypted-column-key-rotation.md
