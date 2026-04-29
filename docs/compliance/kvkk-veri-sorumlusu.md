# KVKK Veri Sorumlusu Beyanı / VERBİS Declaration

**Closes:** [COMPLIANCE-HIGH-007](../reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-HIGH-007)

**Status:** SKELETON. Legal team MUST populate every `<<TBD>>`
placeholder before this declaration is submitted to VERBİS or
referenced in any production-facing compliance report. The
engineering-side commitment is the structure + per-section
content invariants; the legally-binding values are Legal's
responsibility.

---

## 1. Veri Sorumlusu Kimliği (Data Controller Identity)

| Field | Value |
|---|---|
| Tüzel kişi unvanı | `<<TBD — legal entity name as registered with Türkiye Ticaret Sicili>>` |
| MERSİS / Ticaret sicil no | `<<TBD>>` |
| Vergi dairesi / Vergi numarası | `<<TBD>>` |
| Tebligat adresi | `<<TBD>>` |
| KEP adresi | `<<TBD>>` |
| Telefon | `<<TBD>>` |
| Web sitesi | `<<TBD>>` |
| KVKK İrtibat Kişisi (DPO) | `<<TBD — name + email>>` |
| KVKK İrtibat Kişisi telefonu | `<<TBD>>` |

## 2. İşleme Amaçları (Processing Purposes)

The platform processes personal data for the following declared
purposes. Each purpose maps to a specific data category +
retention period (see `retention-matrix.md`).

| ID | Purpose (Turkish) | Purpose (English) | Legal basis (KVKK Art) | Retention |
|---|---|---|---|---|
| P-01 | Üye kaydı ve hesap yönetimi | User registration and account management | Art 5(2)(c) — sözleşme | See retention-matrix.md `auth.users` |
| P-02 | Su ürünleri yetiştiriciliği operasyon yönetimi | Aquaculture operations management | Art 5(2)(c) — sözleşme | See `farm.*` retention rows |
| P-03 | Sensör + IoT veri yutumu | Sensor / IoT data ingestion | Art 5(2)(c) — sözleşme | See `sensor.*` retention rows |
| P-04 | Faturalama ve ödeme işleme | Billing and payment processing | Art 5(2)(c) — sözleşme + Art 5(2)(ç) — yasal yükümlülük | See `billing.*` retention rows |
| P-05 | İnsan kaynakları yönetimi | HR management | Art 5(2)(c) — sözleşme + Art 5(2)(ç) — İş Kanunu yükümlülükleri | See `hr.*` retention rows |
| P-06 | Bildirimler ve iletişim | Notifications and messaging | Art 5(2)(a) — açık rıza | See `messaging.*`, `notification.*` retention rows |
| P-07 | Güvenlik denetimi ve audit log | Security audit logging | Art 5(2)(ç) — yasal yükümlülük | See audit-log retention rows (7y) |
| P-08 | KVKK / GDPR veri sahibi haklarının yerine getirilmesi | Data subject rights fulfilment | Art 11 / Art 13 yükümlülükleri | Permanent (legal evidence) |

## 3. Aktarılan Üçüncü Taraflar (Recipients of Processing)

KVKK Art 8 + Art 9 disclosure. Each recipient + the legal basis
+ the destination country.

| Recipient | Purpose ID | Country | Legal basis | DPA on file |
|---|---|---|---|---|
| Stripe Payments Europe Ltd | P-04 | IE (EU) → US (Stripe Inc) | Art 9(1)(a) — açık rıza + Stripe SCC clauses | `<<TBD — Stripe DPA reference>>` |
| MinIO / DigitalOcean | P-01..P-07 | DE (FRA1 region per ADR-024) | Art 9(1)(a) — açık rıza + DigitalOcean SCC clauses | `<<TBD — DO DPA reference>>` |
| Email service provider (Postmark / SendGrid / equivalent) | P-06, P-08 | US | Art 9(2)(b) — sözleşme uyarınca aktarım + provider SCC clauses | `<<TBD — provider DPA reference>>` |
| Turkish authorities (where legally compelled) | All | TR | Art 8(2)(a) — yasal yükümlülük | N/A |
| `<<TBD — additional sub-processors>>` | | | | |

## 4. Veri Konusu Kişi Grubu (Data Subject Categories)

| ID | Category | Examples |
|---|---|---|
| DS-01 | Tenant administrators | Platform-side admin users with management privileges |
| DS-02 | End users (employees of tenant) | Farm operators, technicians, hatchery workers |
| DS-03 | Hatchery / farm visitors | Auditors, inspectors logged for traceability |
| DS-04 | Customers / billing-side contacts | Tenant-side billing point-of-contact |

## 5. İşlenen Kişisel Veri Kategorileri (Personal Data Categories)

The canonical machine-readable inventory lives in
`docs/compliance/data-inventory.yaml` (planned — see
COMPLIANCE-HIGH-007 follow-on). Until then, the high-level
categories:

| ID | Category | Sensitive (KVKK Art 6)? |
|---|---|---|
| C-01 | Identity (name, surname, TC number) | No |
| C-02 | Contact (email, phone, address) | No |
| C-03 | Authentication (password hash, MFA secrets) | No (Art 6 — special category does NOT include credentials) |
| C-04 | Operational (farm assignments, shift logs) | No |
| C-05 | Audit / log (IP, user-agent, action history) | No (but quasi-identifying) |
| C-06 | Financial (payment metadata, invoice records) | No |
| C-07 | Health (employee medical leave records, where applicable) | **YES — Art 6 sensitive** |

## 6. Saklama Süreleri (Retention Periods)

See [`retention-matrix.md`](./retention-matrix.md) for the
per-table retention table. Each row maps:
- Schema + table → retention duration → KVKK basis →
  destruction method (deletion / anonymisation).

## 7. KVKK Veri Sahibi Hakları (Data Subject Rights)

Per KVKK Art 11, the data subject has the right to:

- Learn whether personal data is being processed.
- Request information regarding processing.
- Learn the purpose of processing and whether it is used
  consistent with that purpose.
- Know the third parties to whom personal data is transferred
  in Türkiye or abroad.
- Request rectification of incomplete or inaccurate data.
- Request erasure or destruction within the framework of the
  conditions set forth in Art 7.
- Object to processing exclusively by automated systems if it
  results in unfavourable consequences.
- Request indemnification for damages arising from unlawful
  processing.

The platform's implementation surfaces:

| Right | Surface | Endpoint |
|---|---|---|
| Right to know / access | Frontend `ConsentSettingsPage` + Right-to-Access GraphQL query | `gdprUserDataExport` |
| Right to rectification | Standard profile-edit flow | (per-resource) |
| Right to erasure | Frontend Right-to-Erasure button (planned per COMPLIANCE-HIGH-003) + farm-service `TenantErasureService` | `tenantErasureInitiate` / `tenantErasureConfirm` |
| Right to portability | Right-to-Portability button (planned) | `gdprUserDataExport` (machine-readable JSON) |
| Right to object / withdraw consent | `ConsentSettingsPage` toggles | `revokeConsent` |

## 8. Yurt Dışı Veri Aktarımı (Cross-Border Transfer)

KVKK Art 9 — explicit consent OR Kurul's adequacy decision OR
SCC-equivalent transfer agreement. The platform's transfer
matrix:

| Recipient | Destination | Mechanism | DPA on file |
|---|---|---|---|
| Stripe Payments | US | SCC + tenant explicit consent at signup | `<<TBD>>` |
| MinIO/DigitalOcean | DE | SCC + Standard EU Adequacy (DE) | `<<TBD>>` |
| Email provider (US) | US | SCC + tenant explicit consent | `<<TBD>>` |

Note: `apps/admin-api-service/src/security/services/compliance.service.ts:806`
`getDataInventory()` currently hardcodes `crossBorderTransfer:
false` for all 4 categories. That's factually incorrect — the
COMPLIANCE-HIGH-007 follow-on tracks the migration to a yaml-
driven inventory that reflects this matrix.

## 9. VERBİS Bildirimi (VERBİS Notification)

`<<TBD — once VERBİS registration is complete>>`

| Field | Value |
|---|---|
| VERBİS sicil numarası | `<<TBD>>` |
| Bildirim tarihi | `<<TBD>>` |
| Yıllık güncelleme | `<<TBD — annually due date>>` |

---

## Engineering-side commitments

This file's STRUCTURE is engineering-owned. Legal-team value
population is operator-owned. The split:

- Engineering MUST keep the section IDs (1..9) stable so
  operator scripts and CI checks bind to predictable anchors.
- Engineering MUST update purpose IDs (P-01..P-08) when a new
  processing purpose is introduced — typically when a new
  service / domain entity ships. Each purpose change is its
  own ADR + retention-matrix update.
- Engineering MUST keep this file referenced from
  `docs/compliance/README.md` AND from the runbook
  `docs/runbooks/kvkk-breach-notification.md`.
- Legal MUST populate every `<<TBD>>` placeholder before the
  declaration is submitted to VERBİS or shared with an
  external auditor.

## Related documents

- [`retention-matrix.md`](./retention-matrix.md) — per-table
  retention authority (canonical reference for KVKK Art 7).
- [`consent-versions.md`](./consent-versions.md) — per-bump
  changelog (KVKK Art 5(2)(a) açık rıza version trail).
- [ADR-024](../adr/) — retention-policy enforcement
  architecture.
- [`docs/runbooks/kvkk-breach-notification.md`](../runbooks/kvkk-breach-notification.md)
  — KVKK Art 12 incident-notification runbook (depends on this
  file's data controller identity section).
