# Incident Response — `sens-api-gateway` v1.6.0

**Audience:** SOC, on-call engineer, incident commander, PSIRT coordinator.

**Purpose:** declare how an availability incident or security incident is classified, run, and closed — severity matrix, incident-commander flow, PSIRT / CVD intake, postmortem template.

---

## 1. Severity classification

Severity is set by the **impact on the customer**, not by internal effort. A bug that takes 10 minutes to fix can still be SEV-1 if it is blocking a line. A refactor that takes a week is SEV-4 if no customer is impacted.

| Severity | Criteria | Example | Response target (Gold tier) |
|----------|----------|---------|-----------------------------|
| **SEV-1** | Service DOWN for ≥ 1 device AND no workaround OR data-loss imminent OR safety-system regression | entire farm offline; offline queue about to overflow; safe-state fails to apply | 15 min response / 4 h fix |
| **SEV-2** | Service DEGRADED OR workaround exists but burdens operator OR SEV-1 avoided by luck | Modbus timeout storm on one PLC with redundant path holding up; watchdog miss trending | 1 h response / 8 h fix |
| **SEV-3** | Single-customer bug, single-device impact, no data loss | a panic observed once in 24 h; single cert expiring in 10 days | 1 business-day response / 30 days fix |
| **SEV-4** | Cosmetic / feature request / doc bug | log formatting glitch; typo in the alert runbook link | roadmap consideration |

**Security-specific severity overlay.** A security finding is classified on CVSS-v3.1 severity AND on exploitation-path reachability. A CVSS-critical that is not reachable (internal-only attack surface, no known exploit) can be a SEV-3. A CVSS-high that is reachable from an unauthenticated external attacker is a SEV-1 regardless of the CVSS number.

---

## 2. Incident-commander flow

Every SEV-1 and SEV-2 incident follows this flow. SEV-3 and SEV-4 follow the normal ticket + review cadence.

```
Detection → Declare → Assemble → Contain → Diagnose → Fix → Verify → Close
  (alert    (create   (IC + on-  (stop the   (root    (durable  (customer  (postmortem
   fires or  incident   call +     bleeding)   cause)   fix or    confirms)  + action
   ticket    in pager   Comms +                        rollback)            items)
   filed)    / tracker) SRE lead)
```

### 2.1 Declare

- Incident is declared in the incident tracker with ID `INC-YYYY-NNNN`.
- Severity assigned by the first responder, confirmed or revised by the Incident Commander (IC) within 15 minutes.
- Declaration kicks off the response-SLA clock per [`support-tiers.md`](./support-tiers.md) §2.

### 2.2 Assemble

**Roles on a SEV-1:**

- **Incident Commander (IC)** — drives the call, owns decisions. Not a technical hands-on role.
- **Technical Lead** — engineer(s) making the fix.
- **Communications Lead** — updates the customer channel every 30 min on SEV-1, every 60 min on SEV-2.
- **SRE Lead** — owns runbooks, telemetry interpretation, and rollback decisions.
- **PSIRT Coordinator** (security incidents only) — owns disclosure and advisory.

One person can hold two roles on smaller teams; IC must be distinct from Technical Lead on SEV-1.

### 2.3 Contain

Stop the bleeding **before** diagnosing. Examples:

- Suspect OTA rollout caused regression → halt rollout, initiate rollback on affected cohort.
- Alarm flood → silence downstream alerts scoped to the incident (incident-scoped TTL, see [`alert-catalogue.md`](./alert-catalogue.md) §6).
- Cert-expiry cascade → emergency-rotate the CA bundle via the control plane.
- Panic triggered by a specific payload → quarantine the input source (firewall rule, broker ACL).

Containment actions are LOGGED into the incident timeline.

### 2.4 Diagnose

- Pull relevant dashboards (see [`monitoring-runbook.md`](./monitoring-runbook.md) §4).
- TTL-bounded log-level flip to DEBUG on affected devices (24 h auto-revert, [`observability.md`](./observability.md#log-volume-slo)).
- Cross-check with recent OTA history, config changes, broker-side changes, cert rotations.
- Capture evidence artefacts: log bundles, `journalctl -u sens-api-gateway --since "-2h"` per affected device, `/diag` endpoint dumps (`src/health.rs:80-145`).

### 2.5 Fix

- Durable architectural fix is preferred; rollback to a last-known-good release is an acceptable fix if the root cause is a recent change.
- Hot-fix (emergency patch release) follows the emergency OTA path in `deployment/ota.md` — canary → 10% → 100% with health-check gating, compressed rollout window.
- NEVER land a non-root-cause mitigation and close the incident. If the mitigation is the only thing that fits in the response window, the incident stays OPEN with status "mitigated" until the root cause is fixed.

### 2.6 Verify

- Customer-visible recovery confirmed on a representative device set: `/healthz` 200, heartbeat present, monitored metrics back to green band.
- Soak window: SEV-1 holds OPEN for 60 min after recovery; SEV-2 for 30 min. Any regression within the soak window re-opens the incident.
- Customer explicitly signs off (for Gold / Platinum tiers) before the incident is moved to VERIFIED.

### 2.7 Close

- Incident ticket is closed with a canonical closure record: timeline, containment actions, root cause, durable fix, customer communications log.
- Postmortem required for every SEV-1 (within 5 business days) and every SEV-2 (within 10 business days).

---

## 3. Security incident path

Security incidents follow the same SEV flow with the following extensions.

### 3.1 PSIRT intake

- Any finding plausibly reachable from outside the device (MQTT payload, Modbus peer, HTTP endpoint, provisioning flow) is a PSIRT case.
- PSIRT coordinator is paged in addition to the primary on-call.
- Public disclosure follows the CVD (Coordinated Vulnerability Disclosure) policy in [`../security/cvd-policy.md`](../security/) — ISO/IEC 30111-aligned.

### 3.2 CVD policy summary (pointer to canonical)

- **Embargo window default:** 90 days from vendor confirmation to public disclosure.
- **Acknowledgement target:** 2 business days to the reporter.
- **Fix target:** 90 days for high / critical; extensions negotiated with the reporter.
- **Advisory channel:** customer-portal security feed + CVE publication.

Canonical text and safe-harbour clause live in [`../security/cvd-policy.md`](../security/).

### 3.3 PSIRT + availability dual-track

When a single incident is both an availability incident (device down) and a security incident (exploitation suspected):

- IC runs both tracks in parallel.
- Containment prioritises security (quarantine / isolation) without requiring vulnerability confirmation — err on the side of containment.
- Customer communication splits into availability updates (all-affected) and security updates (PSIRT-scoped, embargo-respecting).

---

## 4. Postmortem template

Every SEV-1 and SEV-2 gets a postmortem at `docs/incidents/INC-YYYY-NNNN.md`. Blameless framing is mandatory.

```markdown
# Postmortem — INC-YYYY-NNNN

**Date:** YYYY-MM-DD
**Duration:** HH:MM to HH:MM (Xh Ym)
**Severity:** SEV-N
**Customer impact:** one sentence — what users saw.

## Timeline
| Time (UTC) | Event |
|------------|-------|
| T+0        | alert fires |
| T+3m       | IC assigned |
| ...        | ... |

## Root cause
(one paragraph — the architectural reason, not the symptom)

## Contributing factors
- absence of an alert that would have caught this earlier
- monitoring gap
- process gap
- recent change (OTA / config / cert)

## What went well
- fast detection
- clean rollback path

## What went poorly
- missing runbook for this specific signature
- ambiguous ownership during containment

## Action items
| # | Action | Owner | Due | Ticket |
|---|--------|-------|-----|--------|
| 1 | Add alert rule EdgeX | SRE lead | YYYY-MM-DD | ENG-NNN |
| 2 | Document Y in runbook | Writer | YYYY-MM-DD | DOC-NNN |
| 3 | Orphan finding registered in `docs/reviews/orphan-findings.md#ORPHAN-...` | ... | ... | ... |

## Customer communication log
(chronological list of customer-facing updates sent)
```

**Rule:** every action item has an owner and a date. Items without both are a postmortem defect. Items that don't land in the committed plan in 30 days get escalated to the architectural arbiter.

---

## 5. Orphan-finding integration

Every incident that surfaces an issue that is real but not in the current iteration plan must generate an orphan finding in `docs/reviews/orphan-findings.md` with ID `ORPHAN-EDGE-N`. The postmortem links to it.

The orphan-findings doc is the canonical backlog for "known issues not yet scheduled". It is the bridge between incident learning and the planning cycle.

---

## 6. Communication templates

### 6.1 Initial customer notice (SEV-1, first 15 min)

> **Subject:** [SEV-1 INC-YYYY-NNNN] Service issue — investigation in progress
>
> We are investigating a service issue affecting *(scope — fleet / site / device set)*. An Incident Commander and engineering team are engaged. We will send the next update within 30 minutes.
>
> **Impact:** *(one sentence)*
>
> **Current status:** investigating.
>
> **Workaround available:** *(yes / no)* — *(detail)*.

### 6.2 Resolution notice

> **Subject:** [SEV-N INC-YYYY-NNNN] Resolved — postmortem to follow
>
> Service was restored at HH:MM UTC. Total customer-visible impact: X minutes.
>
> **Root cause (preliminary):** one paragraph.
>
> A full postmortem with action items will be published within 5 business days (SEV-1) / 10 business days (SEV-2).

---

## 7. On-call logistics

- On-call rotations are weekly; primary + secondary on every rotation.
- Holdover to secondary on primary no-response after 10 minutes (Gold) / 5 minutes (Platinum).
- Executive escalation (VP Support / CTO) on SEV-1 not resolved within tier-declared fix window.
- PSIRT-CC is paged in parallel to on-call for any panic, audit-chain-break, or externally-reachable fault.

---

## 8. Drills

| Drill | Cadence | Tiers covered | Owner |
|-------|---------|---------------|-------|
| Tabletop incident (SEV-1 availability) | quarterly | internal + Gold-tier customers opt-in | SRE lead |
| Tabletop incident (SEV-1 security) | semi-annually | internal + Platinum-tier customers | PSIRT CC |
| DR drill (cert revocation + re-provision) | annually | Gold / Platinum customers | Customer-success |
| Pager routing test (dead-man switch silence) | monthly | internal | SRE |

Drill findings feed the orphan-findings backlog.

---

## 9. Evidence & open items

- `src/health.rs:80-145` — `/diag` endpoint, the primary diagnostic artefact during incidents.
- Open: `docs/incidents/` directory not yet established. Owner: SRE. Target: first SEV-1 postmortem.
- Open: `../security/cvd-policy.md` is ROADMAP — pointer target. Owner: security-architecture-writer.
- Open: customer-portal security advisory feed is provider-side infrastructure, not a `sens-api-gateway` concern, but referenced here.
