# Support Tiers — `sens-api-gateway` v1.6.0

**Audience:** procurement, customer-success, service-contract lawyer.

**Purpose:** declare the support matrix across Bronze / Silver / Gold / Platinum tiers — response time, fix time, coverage hours, channels, update cadence, onsite support, spare-parts pool.

**Pricing:** every `{TEMPLATE}` placeholder in this document is a contract-level value filled by the sales team per MSA. The technical contract shape is committed here; the commercial numbers are not.

---

## 1. Tier summary

| Attribute | Bronze | Silver | Gold | Platinum |
|-----------|--------|--------|------|----------|
| Annual price per device | `{TEMPLATE}` | `{TEMPLATE}` | `{TEMPLATE}` | `{TEMPLATE}` |
| Coverage hours | Business 8×5 | Business 12×5 | 24×7 | 24×7 |
| Time zone | customer-local | customer-local | follow-the-sun | follow-the-sun |
| Availability SLA | 95.0% | 99.0% | 99.5% | 99.9% |
| Primary channel | Email + ticketing portal | Email + ticketing + chat | Ticketing + chat + phone | Ticketing + chat + phone + named TAM |
| Named TAM (Technical Account Manager) | — | — | shared-pool | named-dedicated |
| Quarterly business review | — | optional | included | included |
| Monthly operations review | — | — | optional | included |

Columns with `{TEMPLATE}` are populated in the MSA exhibit.

---

## 2. Response + fix SLAs

Response = time from incident creation on our side (ticket filed, alert fired that we acknowledged, or customer report confirmed) to a human engineer actively working on it. Fix = time from response to a durable resolution (workaround acceptable if it restores service).

| Severity | Bronze response / fix | Silver response / fix | Gold response / fix | Platinum response / fix |
|----------|-----------------------|-----------------------|---------------------|-------------------------|
| SEV-1 (service down, data-loss imminent) | 8 business-h / next-business-day | 4 business-h / 16 business-h | **15 min / 4 h** | **15 min / 2 h** |
| SEV-2 (degraded, customer workaround exists) | 1 business-day / 5 business-days | 8 business-h / 3 business-days | 1 h / 8 h | 30 min / 4 h |
| SEV-3 (minor bug, single customer) | 5 business-days / next-minor-release | 3 business-days / next-minor-release | 1 business-day / 30 days | 4 h / 14 days |
| SEV-4 (cosmetic, feature request) | best-effort | roadmap consideration | roadmap consideration | roadmap with quarterly review |

Severity definitions are in [`incident-response.md`](./incident-response.md).

---

## 3. Updates + patching

| Update type | Bronze | Silver | Gold | Platinum |
|-------------|--------|--------|------|----------|
| Security patch (critical CVE) | 30 days from release | 14 days | 7 days | 48 h staged rollout |
| Security patch (high) | 60 days | 30 days | 14 days | 7 days |
| Minor release (features) | customer-scheduled | customer-scheduled | customer-scheduled w/ provider-assist | provider-managed w/ customer approval |
| Major release (breaking) | 18-month notice (see [`lifecycle-eol.md`](./lifecycle-eol.md)) | 18-month notice | 18-month notice + migration support | 18-month notice + migration co-ownership |
| LTS maintenance (36-month, every 4th minor) | included | included | included | included |

**OTA channels:** `stable` (Bronze/Silver default), `stable-staged` (Gold default), `stable-canary-first` (Platinum default — customer device can be in a canary cohort before fleet-wide rollout).

---

## 4. Onsite support

| Scenario | Bronze | Silver | Gold | Platinum |
|----------|--------|--------|------|----------|
| Onsite dispatch for SEV-1 | not included | quotable | included up to `{TEMPLATE}` visits/year | included unlimited within region |
| Onsite for major version migration | not included | quotable | quotable at preferred rate | included, scheduled |
| Scheduled preventive maintenance visit | — | — | annual | quarterly |

Onsite dispatch assumes the site is reachable within the provider's declared service regions (see MSA annex "Service Regions"). Remote regions carry a travel surcharge quoted per trip.

---

## 5. Spare-parts pool

| Item | Bronze | Silver | Gold | Platinum |
|------|--------|--------|------|----------|
| Pre-provisioned replacement edge device on-site | — | — | optional, customer-funded | included, 1 spare per 10 deployed devices |
| Replacement device shipment SLA | 10 business-days | 5 business-days | next-business-day | same-day within region, next-business-day out-of-region |
| Hot-swap spare SKU (hardware class and firmware image matched) | — | optional | optional | included |

**Note on ownership.** Spare devices shipped under Platinum pool remain provider property until a consumption event (swap) occurs. At swap, title passes and the replenishment ship is initiated.

---

## 6. Incident-scoped tier uplift

A customer at Bronze / Silver / Gold can purchase an **incident-scoped Platinum uplift (TTL = incident MTTR window)** to get Platinum response+fix clocks for a specific active incident. The uplift is finite-duration — it terminates automatically at incident closure or at a hard 72-hour cap, whichever comes first. Billing: flat fee per uplift, filed within 5 business days of incident closure.

A customer can purchase a finite-duration Platinum uplift for a scheduled event (planned migration weekend, major PLC cut-over) — uplift window declared in advance, capped at 168 hours per event, billed as a scheduled uplift.

---

## 7. Included vs quoted

| Activity | Bronze | Silver | Gold | Platinum |
|----------|--------|--------|------|----------|
| Incident response within SLA | included | included | included | included |
| Root-cause analysis report on SEV-1 / SEV-2 | abbreviated | full | full + review call | full + review call + action-item tracking |
| Postmortem document | — (summary only) | customer-readable | customer-readable | customer-readable + blameless-review co-authored |
| Training (per-seat, remote) | quoted | 8 h/year included | 24 h/year included | 48 h/year included + onsite option |
| Custom protocol driver development | quoted | quoted | quoted at preferred rate | quoted at preferred rate + priority queueing |
| DR drill (annual) | — | quoted | quoted | included, scheduled |

---

## 8. Escalation path

Every tier has a four-stage escalation path. Higher tiers compress the stage duration.

| Stage | Bronze | Silver | Gold | Platinum |
|-------|--------|--------|------|----------|
| Stage 1: first responder | 8 business-h | 4 business-h | 15 min | 15 min |
| Stage 2: engineering on-call | 2 business-days | 8 business-h | 1 h | 30 min |
| Stage 3: senior engineer + incident commander | 5 business-days | 2 business-days | 4 h | 1 h |
| Stage 4: executive bridge (CTO / VP Support) | ticket escalation on SEV-1 only | SEV-1 only | SEV-1 within 4 h | SEV-1 within 1 h |

Customer-initiated escalation is always allowed; the ticket moves to the next stage on customer request without internal gatekeeping.

---

## 9. Exit + renewal

- Contract term: annual, auto-renew with 90-day opt-out notice.
- Tier downgrade: takes effect at the next contract anniversary (avoids mid-term SLA-band changes).
- Tier upgrade: effective next calendar month, prorated.
- Data-export on exit: all customer telemetry and audit artefacts exported in open formats (JSONL + Parquet) within 30 days of contract end. Format detailed in `../commercial/` data-residency section.

---

## 10. Evidence & open items

- Pricing placeholders `{TEMPLATE}` are filled per MSA; the template structure itself is the committed contract shape.
- Open: "customer-success portal" tooling (ticket intake, response-time automation) not detailed here — see `../commercial/` MSA annex.
- Open: service-region list (where onsite dispatch is included vs quoted). Owner: commercial-legal-writer. Target: MSA annex v1.
