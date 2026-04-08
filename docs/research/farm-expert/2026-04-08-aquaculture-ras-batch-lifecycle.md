# Research: Aquaculture (RAS) Batch Lifecycle, FCR, Biomass — Domain Rules

**Topic:** How production aquaculture (recirculating aquaculture systems) domain models track batches, compute feed conversion ratio, and manage biomass through the growth cycle.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [Smart Recirculating Aquaculture System (RAS) Explained — Folio3 AgTech](https://agtech.folio3.com/blogs/recirculating-aquaculture-system-explained/)
- [Recirculating Aquaculture Tank Production Systems — SRAC 453 (University of Florida IFAS)](https://shellfish.ifas.ufl.edu/wp-content/uploads/Handout-3_SRAC_0453_Review-of-Current-Design-Practices_Recirculating-Aquaculture-Systems.pdf)
- [Computer simulation for design and management of RAS (ResearchGate)](https://www.researchgate.net/publication/221989002_Computer_simulation_for_design_and_management_of_recirculating_aquaculture_systems)
- [Implementation of a dynamic simulator for RAS (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0144860919302183)
- [Recirculating aquaculture systems: advances, impacts (ScienceDirect, 2025)](https://www.sciencedirect.com/science/article/abs/pii/S2589014X25003238)
- [PR Aqua — Experts in Recirculating Aquaculture Systems](https://praqua.com/)

## Key Findings

1. **A "batch" in aquaculture production is a cohort** — a group of fish stocked on the same day with the same species, genetic line, and initial characteristics. Batches move through tanks over time and may be split or merged.
2. **Core batch lifecycle states:** `QUARANTINE → ACTIVE → HARVESTING → CLOSED`. Quarantine is mandatory for disease control on new stock. HARVESTING is a partial state — the batch continues to produce biomass until fully harvested. CLOSED requires all biomass to be harvested, sold, or mortality-accounted-for.
3. **Biomass formula:** `biomassKg = (quantity × avgWeightG) / 1000`. This is the single most important derived quantity in the system — every capacity, density, and feeding calculation depends on it.
4. **Feed Conversion Ratio (FCR) = total feed consumed / total biomass gained.** A healthy RAS fish batch typically has FCR between 0.8 and 1.5, depending on species. FCR > 2.0 usually indicates overfeeding, disease, or poor water quality.
5. **Specific Growth Rate (SGR) = `(ln(weight_end) - ln(weight_start)) / days × 100`** — expressed as percent per day. Used for growth performance comparison across batches.
6. **Three-layer growth model:**
   - `initial` — the stocking-time values (quantity, avg weight, biomass).
   - `theoretical` — what the model predicts based on FCR targets and feed input.
   - `actual` — sampled measurements (periodic weighings).
   - Variance between theoretical and actual triggers growth alerts. A theoretical-vs-actual delta > 15% is a HIGH concern (disease, malnutrition, or stock count error).
7. **Tank capacity is enforced by two constraints:**
   - `maxBiomass` — absolute biomass limit in kg.
   - `maxDensity` — biomass per m³ of water volume.
   Both must be respected on every allocation, transfer, and growth event. `skipCapacityCheck` flags must be audited for misuse.
8. **Mortality tracking is mandatory.** Every mortality event (individual death, cull, unexplained loss) must reduce the active quantity and biomass. Undercounting mortality inflates FCR artificially.
9. **Tank transfers** require source validation (sufficient quantity) and destination validation (sufficient capacity — both maxBiomass and maxDensity).
10. **Harvest partial vs full:** partial harvests update `currentQuantity` and `currentBiomassKg`. Full harvests transition the batch to CLOSED state and trigger final FCR, mortality rate, and days-in-production calculations.
11. **Mixed-batch tanks** require a `batchDetails` array that tracks per-batch proportions within the shared tank. This is necessary for FCR attribution when multiple batches share feed.
12. **Water quality parameters** (DO, temperature, pH, ammonia, nitrite, nitrate, salinity, alkalinity) directly affect growth and mortality. WQ excursions must trigger batch-level alerts.

## Security Concerns
- Tenant-scoped batch and tank data — cross-tenant visibility of production data is an industrial-espionage concern in aquaculture. All batch queries must be tenant-isolated.
- `skipCapacityCheck` flag abuse can mask over-stocking that damages fish welfare (potentially a regulatory / animal welfare concern in some jurisdictions).
- Sentinel Hub / weather API credentials must never leak to the frontend (separate research file on this).

## Performance Concerns
- Real-time water quality telemetry can reach ~1 reading per sensor per 10-30 seconds, per tank, per tenant. Aggregation into continuous rollups (TimescaleDB continuous aggregates) is mandatory for dashboard performance.
- Biomass and FCR calculations must NOT re-walk the entire event history on every query — use snapshots (per-day or per-week) for read-model performance.
- Growth variance calculations over 30+ day windows need indexed timestamp columns.

## Architectural Implications for farm-expert reviews
- Missing state machine enforcement on batch transitions = HIGH (e.g. closing a batch without harvesting the remaining stock).
- Mortality/cull command that does NOT verify the source tank has active batch with sufficient quantity = HIGH (data integrity).
- Transfer command that does NOT validate destination capacity (both maxBiomass AND maxDensity) = HIGH.
- Close-batch command that does NOT calculate final FCR, mortality rate, days-in-production = HIGH (missing audit data).
- FCR calculated on-demand by walking events = MEDIUM (performance); HIGH if on a hot path.
- Missing water quality excursion → batch alert integration = MEDIUM (operational visibility).
- `skipCapacityCheck` usage without an audit log entry = HIGH.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules → Batch Lifecycle (Critical)`:
- State transitions enforced strictly: `QUARANTINE → ACTIVE → HARVESTING → CLOSED`. Direct `ACTIVE → CLOSED` permitted only when final harvest event exists. Transitions out of order = CRITICAL data integrity violation.
- Mortality events MUST decrement both quantity and biomass atomically within a transaction. Non-atomic mortality = HIGH (inflates FCR).
- `batchDetails` array on mixed-batch tanks MUST track per-batch proportions; FCR attribution without per-batch proportions = HIGH.
- SGR calculation MUST use `ln(weight_end) - ln(weight_start)` natural log formula, NOT linear percent. Linear SGR = MEDIUM (incorrect math) unless explicitly documented as a display simplification.
- Growth variance `(actual - theoretical) / theoretical` > 15% MUST trigger a batch-level alert. Missing alert = MEDIUM.
- `skipCapacityCheck` flag usage MUST create an audit log entry with justification. Unaudited use = HIGH.
- Close-batch command MUST compute final FCR, mortality rate, and days-in-production before marking CLOSED. Missing final metrics = HIGH.
