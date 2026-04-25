# Pricing & Commercial Summary — Siemens RFP

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE (numbers pending per-deal).** Every price value in this document is a `{TEMPLATE}` placeholder. Sales + finance completes actual numbers per deal based on scope + volume + support tier + jurisdiction. This document describes the pricing *structure* and commercial levers; it is not a price list.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 6 | 46.2% |
| PARTIAL | 5 | 38.4% |
| ROADMAP | 0 | 0% |
| N-A | 2 | 15.4% |
| **Total questions** | **13** | **100%** |

---

## Section 1 — Licensing Model

### Q1.1 — Licence structure

Q: Describe the licence structure offered.
A: Three-tier model:
1. **Per-device perpetual** — one-time perpetual licence per running edge device, entitling the operator to the installed version + a grace window of minor updates. `{TEMPLATE — EUR/device}`.
2. **Per-site subscription** — annual subscription per deployment site covering an unlimited number of edge devices at that site; includes major-version upgrades. `{TEMPLATE — EUR/site/year}`.
3. **Per-tenant (multi-site)** — enterprise tier covering an unlimited number of sites under a single tenant; includes dedicated support channel + named engineering contact. `{TEMPLATE — EUR/tenant/year}`.

Each tier is available in an *open-source-integration* variant at a discount where the customer uses the product exclusively with OSS-licensed PLCs + sensors (no proprietary add-ons).
Evidence: `docs/commercial/licensing.md`
Status: FULL (structure); PARTIAL (numeric rates per-deal)

### Q1.2 — Licence enforcement mechanism

Q: How is licence compliance enforced technically?
A: Signed licence token (Ed25519) embedded in the installation. Edge device validates the token at every boot + periodic (24h) audit-log entry. Non-expiry + revocation-list check when cloud-sync is available. No online-activation requirement — the product works fully offline for up to 90 days after the last successful revocation-check, then warns loudly without locking out production operations (safe-fail rather than fail-close; industrial-control availability guarantee).
Evidence: `docs/commercial/licensing.md` §Enforcement
Status: FULL

---

## Section 2 — Pricing Tiers

### Q2.1 — Volume tiering

Q: Volume discount schedule.
A: `{TEMPLATE}` — typical bands: 1-10 devices list price; 11-50 devices `-{TEMPLATE}%`; 51-250 devices `-{TEMPLATE}%`; 251-1000 devices `-{TEMPLATE}%`; 1000+ devices `{TEMPLATE — negotiated}`.
Evidence: `docs/commercial/pricing.md`
Status: PARTIAL (structure fixed; % bands per-deal)

### Q2.2 — Multi-year commitment discount

Q: Multi-year pre-pay discount.
A: 1-year term: list. 3-year term: `-{TEMPLATE}%`. 5-year term: `-{TEMPLATE}%`. Pre-payment required for multi-year discount; annual true-up for device-count change.
Evidence: `docs/commercial/pricing.md`
Status: PARTIAL (structure fixed; % rates per-deal)

### Q2.3 — Non-profit / research discount

Q: Non-profit + academic pricing.
A: `{TEMPLATE}`. Research and non-profit installations may qualify for up to `{TEMPLATE}%` off list; case-by-case evaluation.
Evidence: `docs/commercial/pricing.md`
Status: PARTIAL

---

## Section 3 — Support & Maintenance

### Q3.1 — Support tiers

Q: Describe support tiers.
A: Three support tiers (fully documented in `docs/operations/support-tiers.md`):
1. **Bronze** — email-only, business-hours (CET), 72h response for CRITICAL / 5 business days otherwise. Included free with any perpetual licence; annual subscription tier for subscription customers.
2. **Silver** — email + ticket portal, 24h response for CRITICAL / 2 business days HIGH / 5 business days MEDIUM-LOW. 24/7 emergency on-call for CRITICAL production-down events. `{TEMPLATE — EUR/site/year}`.
3. **Gold** — Silver + dedicated named engineer + quarterly review call + 2h response for CRITICAL / 1 business day HIGH / 3 business days MEDIUM-LOW / 2 business days LOW. Direct escalation to engineering. `{TEMPLATE — EUR/tenant/year}`.

Security advisories + PSIRT communications: free across all tiers (part of CVD policy obligation, not a commercial feature).
Evidence: `docs/operations/support-tiers.md`, `docs/security/cvd-policy.md`
Status: FULL (tiers); PARTIAL (rates per-deal)

### Q3.2 — Maintenance model

Q: Included maintenance.
A: Subscription tiers: all minor + major version updates included; security patches included regardless. Perpetual-licence tier: minor version + security patches free for 24 months from purchase; major version upgrade `{TEMPLATE}%` of original licence price.
Evidence: `docs/commercial/maintenance.md`
Status: FULL (structure); PARTIAL (upgrade % per-deal)

---

## Section 4 — Implementation Services

### Q4.1 — Professional services rates

Q: Day rate for implementation + customisation.
A: `{TEMPLATE — EUR/day}` for standard Senior Engineer. Rate card at `docs/commercial/professional-services.md`. Minimum engagement 5 days; larger engagements quoted per SoW.
Evidence: `docs/commercial/professional-services.md`
Status: PARTIAL (rate per-deal)

---

## Section 5 — Commercial Terms

### Q5.1 — Payment terms

Q: Standard payment terms.
A: Net 30 days on issuance of invoice. Late fee `{TEMPLATE}%` p.a. after grace. Multi-year pre-pay discount available (§2.2). Milestone-based payment plans available for professional-services SoWs above `{TEMPLATE — EUR threshold}`.
Evidence: `docs/commercial/payment-terms.md`
Status: PARTIAL

### Q5.2 — Currency + jurisdiction

Q: Contract currency + governing law.
A: Currency: EUR default; USD / GBP / TRY optional per customer. Governing law: `{TEMPLATE — e.g. laws of England and Wales}` or jurisdiction of customer's choice under reasonable commercial agreement. Dispute resolution: tiered — direct negotiation → mediation → arbitration (ICC Rules, seat `{TEMPLATE}`).
Evidence: `docs/commercial/contract-template.md`
Status: FULL (structure); PARTIAL (jurisdiction per-deal)

### Q5.3 — Price validity

Q: Price validity window.
A: Quotes valid for 60 days from issuance unless otherwise stated. Price locked for the duration of a contracted term (subscription tiers) + for 12 months on perpetual-tier quotes.
Evidence: `docs/commercial/pricing.md`
Status: FULL

---

## Section 6 — Hardware Pricing (HARDWARE-VENDOR RESPONSIBILITY)

### Q6.1 — Edge-device hardware cost

Q: Typical hardware cost per deployment.
A: N-A. Hardware procurement is HARDWARE-VENDOR RESPONSIBILITY. Supplier can recommend qualified hardware vendors + negotiated volume-purchase arrangements as a convenience service, but bills hardware at cost with no markup in that case.
Evidence: `docs/deployment/hardware-qualification-matrix.md`
Status: N-A (HARDWARE-VENDOR RESPONSIBILITY)

### Q6.2 — Sensor + actuator pricing

Q: Pricing for sensors + actuators.
A: N-A. HARDWARE-VENDOR RESPONSIBILITY. Atlas Scientific / Shelly / industrial-vendor catalog prices apply; Supplier does not resell.
Evidence: `docs/deployment/hardware-qualification-matrix.md`
Status: N-A (HARDWARE-VENDOR RESPONSIBILITY)

---

## Summary

- Pricing *structure* is FULL + stable — tiers, volume-bands, multi-year discounts, support tiers, payment terms, currency, governing-law patterns are all fixed in the commercial template.
- Pricing *numbers* are `{TEMPLATE}` — sales + finance sets per deal based on scope + volume + support tier + jurisdiction.
- Hardware pricing is HARDWARE-VENDOR RESPONSIBILITY by design — supplier is a firmware business, not a hardware reseller.

Every `{TEMPLATE}` marker is a known question; the numbers are set per-deal during negotiation.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
