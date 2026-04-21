# Compliance Evidence

Operator-facing evidence files for SOC2 / KVKK / GDPR auditor review.

## Directory shape

- `evidence/<finding-id>.md` — attestation that a CRITICAL or HIGH
  finding has been resolved with verifiable controls, not just a
  code change. Format in `evidence/_template.md`.
- `kvkk-veri-sorumlusu.md` (planned per plan v3 R4) — VERBİS declaration.
- `retention-matrix.md` (planned per plan v3 R17 + ADR-024) — authoritative
  per-table retention policy.

## Attestation coverage gate

`tools/gates/compliance-attestation-coverage.ts` asserts every RESOLVED
CRITICAL/HIGH finding closed on or after the
`ATTESTATION_REQUIRED_FROM` cutoff has a matching evidence markdown.
Grandfathers pre-cutoff findings — retroactive attestation is not
required.

Run locally:

```bash
# Plain check (uses cutoff from env or ISO far-future)
ATTESTATION_REQUIRED_FROM=2026-04-21T00:00:00Z \
  npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/compliance-attestation-coverage.ts
```

Exit 0 = covered; exit 1 = missing attestations; exit 2 = input error.
