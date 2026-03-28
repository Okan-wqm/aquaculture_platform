/**
 * TraceLotQuery
 *
 * Retrieves all stock movements for a given lot number within a tenant,
 * ordered chronologically by performedAt ASC.
 *
 * This enables full forward and backward traceability as required by:
 * - EU Regulation 178/2002 Article 18: "traceability of food...shall be
 *   established at all stages of production, processing and distribution"
 * - BAP (Best Aquaculture Practices) standard 2.3.4: lot tracking
 * - HACCP Principle 7: record-keeping for hazard analysis
 *
 * Use cases:
 * - Forward trace: "Where did lot LOT-2026-0042 end up?" (which tanks, feeding events)
 * - Backward trace: "Where did the feed in Tank A come from?" (supplier, delivery, lot)
 * - Recall: "Find all consumption points for recalled lot X" (regulatory requirement)
 */
export class TraceLotQuery {
  constructor(
    public readonly lotNumber: string,
    public readonly tenantId: string,
  ) {}
}
