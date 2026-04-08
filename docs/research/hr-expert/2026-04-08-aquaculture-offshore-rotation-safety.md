# Research: Aquaculture Offshore Rotation Safety

**Topic:** Sea-worthiness certification expiry, rotation tracking, crew assignment validation, safety training currency
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [IMO - International Convention on STCW](https://www.imo.org/en/ourwork/humanelement/pages/stcw-conv-link.aspx)
- [MITAGS - Guide to STCW Certification](https://www.mitags.org/guide-to-stcw-certification/)
- [USCG NMC - Standards of Training, Certification, and Watchkeeping (STCW)](https://www.dco.uscg.mil/nmc/stcw/)
- [Marine Public - STCW Guide: Latest 2026 Amendments](https://marinepublic.com/blogs/marine-law/887924-stcw-guide-certificates-latest-2026-amendments-costs)
- [SAFETY4SEA - New STCW requirements effective from 2026](https://safety4sea.com/cm-regulatory-focus-new-stcw-requirements-effective-from-2026/)
- [OneOcean - STCW PSSR update 2026: SASH training requirements](https://www.oneocean.com/insights/stcw-updates-addressing-violence-and-harassment-through-pssr-training)
- [OSHA - 1910.146 Permit-required confined spaces](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.146)
- [Maine DMR - Commercial Fishing Safety Training](https://www.maine.gov/dmr/marine-patrol/boating-safety/training)

## Key Findings

1. **STCW (Standards of Training, Certification and Watchkeeping for Seafarers)** is the IMO convention governing seafarer qualifications worldwide. Ratified by nations covering >99% of global shipping tonnage — it is the baseline for any offshore worker on a vessel.
2. **STCW Basic Safety Training (BST)** is mandatory before a crewmember may work at sea and consists of 4 core modules:
   - Personal Survival Techniques (PST)
   - Fire Prevention and Firefighting (FPFF)
   - Elementary First Aid (EFA)
   - Personal Safety and Social Responsibility (PSSR)
3. **Certificates expire every 5 years** and require refresher training (STCW 2010 Manila Amendments). Expired BST disqualifies the worker from any assignment requiring sea-worthiness.
4. **2026 STCW Amendments (Resolution MSC.560(108))** took effect 1 January 2026. Part A of the STCW Code fully replaces Table A-VI/1-4 (PSSR) and introduces mandatory new training on the prevention and response to sexual assault, sexual harassment, bullying, and other harassment on board — applies to all approved training courses from 1 January 2026.
5. **OSHA 1910.146 (Permit-Required Confined Spaces)** governs hatchery tanks, fish holds, ballast tanks, and similar enclosed spaces. Employers must certify workers before entry; must provide retrieval harness + line; must perform atmospheric testing; must have a standby attendant and rescue plan.
6. **Rotation tracking for offshore workers** must record: rotation start/end timestamps, vessel/site ID, check-in timestamps (regular muster/accounting), safety-briefing acknowledgment, and medical-fit-for-work status at rotation start.
7. **Fit-for-work medical** (ENG1 in UK, similar elsewhere) is typically 2-year validity; expired medical disqualifies worker from offshore assignment regardless of STCW currency.
8. **Aquaculture-specific hazards** not covered by pure maritime regs: H2S in confined fish tanks, drowning in net pens, entanglement in mooring lines, electrical hazards near water, and bio-hazards from handling diseased stock. These require site-specific training on top of STCW BST.
9. **The "currency" check is a point-in-time query:** at rotation start T, every required certification must have `issued_at <= T AND expires_at > T + rotation_duration`. A cert that expires mid-rotation is a disqualifier, not a warning.
10. **Cascading disqualification:** when a certification expires, the system must (a) prevent new rotation assignments for the worker, (b) raise an event if the worker is currently on rotation so HR/safety can plan extraction or relief.

## Security Concerns

- **CRITICAL (LIFE-SAFETY):** Worker with expired BST placed on offshore rotation = regulatory violation + direct life-safety exposure. Must be a blocking constraint at the database level, not an application warning.
- **CRITICAL (LIFE-SAFETY):** Worker with expired medical assigned to confined-space entry = OSHA violation and direct life-safety exposure.
- **CRITICAL:** Silent failure of the daily cert-expiry cron (no alert) produces a gradual accumulation of expired-but-still-active certifications — the system thinks everyone is current.
- **HIGH:** Missing check-in during rotation is a man-overboard / accident signal — must trigger an alert, not be silently ignored.
- **HIGH:** Rotation assignment without safety-briefing acknowledgment violates many national safety codes and insurance terms.
- **MEDIUM:** Timezone confusion on certificate expiration — an expiration stored in local vessel time vs UTC can give a 24-hour grace window where worker is legally expired but allowed to work.

## Performance Concerns

- Cert-expiry daily cron over N employees × M certification types is O(N·M). Use a single SQL query with an index on `(tenant_id, expires_at)` to return only rows expiring in the next window.
- Rotation current-status query for alerts should read from an indexed `rotation_active` materialized view, not full-scan the rotation history.
- Check-in missed-alert query is a left-join between `scheduled_checkins` and `actual_checkins` — must be indexed on `(rotation_id, expected_at)`.

## Architectural Implications for hr-expert reviews

- `Certification` entity must carry: `type ENUM`, `issued_at timestamptz`, `expires_at timestamptz`, `issuing_authority`, `certificate_number`, and a document-reference (S3 URL + checksum) of the physical cert scan.
- `WorkArea` and `VesselRole` entities must declare `required_certifications: CertificationType[]`. The scheduler must reject assignment if the employee lacks any required cert valid through rotation end.
- `OffshoreRotation` entity: `employee_id`, `vessel_id`, `role_id`, `rotation_range tstzrange`, `status ENUM(PLANNED, ACTIVE, COMPLETED, ABORTED)`, `safety_briefing_ack_at`, `medical_verified_at`, `boarded_at`, `disembarked_at`.
- Check-in tracking: `RotationCheckIn(rotation_id, expected_at, actual_at, location, acknowledged_by)` with a daily job producing `CheckInMissedEvent` where `actual_at IS NULL AND expected_at < NOW() - 1 hour`.
- Daily cert-expiry cron publishes two event types: `CertificationExpiringSoonEvent` (30/14/7/1 days before expiry — configurable) and `CertificationExpiredEvent` (on the day of expiry).
- Rotation assignment command must be a pure validation gate: check certs valid through rotation end + medical valid + no overlapping active rotation + safety briefing scheduled. Fail any = reject command.
- `RotationAbortedEvent` must be published when an active rotation is terminated due to certification loss, worker injury, or emergency — consumed by notification-service to alert HR, safety, and vessel operations.
- All life-safety code paths must be marked with `// LIFE-SAFETY:` comments.

## Domain Rule Additions for hr-expert

- **[CRITICAL LIFE-SAFETY]** Rotation assignment must validate that every required certification is valid from rotation start through rotation end inclusive. A certificate expiring mid-rotation disqualifies the worker. Assignments bypassing this check are a blocking review failure.
- **[CRITICAL LIFE-SAFETY]** Medical fit-for-work validity must be checked at rotation start; an expired medical blocks assignment regardless of other certification currency.
- **[CRITICAL LIFE-SAFETY]** STCW Basic Safety Training (PST, FPFF, EFA, PSSR) must be modeled as four separate certification types each with independent expiry; treating STCW BST as a single aggregate mask expired sub-modules and is a blocking review failure.
- **[CRITICAL LIFE-SAFETY]** Work-area assignments (fish tanks, net pens, confined spaces) must validate against OSHA 1910.146-equivalent training for confined-space entry; workers without valid confined-space cert must be blocked from those work areas at the DB layer.
- **[CRITICAL]** Daily certification expiry cron must publish `CertificationExpiringSoonEvent` at configurable thresholds (default 30/14/7/1 days) and `CertificationExpiredEvent` on the day of expiry. A silent cron failure must raise a P0 alert.
- **[CRITICAL]** Rotation assignment during the 2026-active STCW amendments must require the updated PSSR module covering prevention of violence and harassment on board. Legacy PSSR certificates predating Jan 1, 2026 must be flagged for refresher scheduling.
- **[HIGH]** Every `OffshoreRotation` must record `safety_briefing_ack_at` before `boarded_at`. Missing safety briefing acknowledgment before boarding is a blocking validation failure.
- **[HIGH]** Check-in tracking: `RotationCheckIn` must be scheduled at intervals defined by the tenant policy (default every 12h); a missed check-in for > 1 hour must publish `CheckInMissedEvent` consumed by notification-service (life-safety alert).
- **[HIGH]** All rotation and certification timestamps must be `timestamptz`. Storing expiry as `timestamp without time zone` gives 24-hour grace windows where expired workers appear current. Blocking review failure.
- **[HIGH]** Concurrent rotations (worker assigned to two vessels simultaneously) must be prevented by a partial GiST exclusion constraint on `(tenant_id, employee_id, rotation_range)` filtered by `status IN ('PLANNED', 'ACTIVE')`.
- **[HIGH]** Certificate documents (scans, PDFs) must be stored in object storage with checksum verification; a cert entity without a document reference is incomplete and cannot defend an audit.
- **[MEDIUM]** Rotation events (`RotationStartedEvent`, `RotationCompletedEvent`, `RotationAbortedEvent`, `CheckInMissedEvent`) must flow through the outbox and be marked life-safety priority in NATS JetStream.
- **[MEDIUM]** All life-safety code paths must be marked with `// LIFE-SAFETY:` comments and must have dedicated unit tests.

Research: `docs/research/hr-expert/2026-04-08-aquaculture-offshore-rotation-safety.md`
