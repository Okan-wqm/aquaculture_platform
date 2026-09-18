/**
 * FARM-AI PR-4 — Production specialty.
 *
 * The bundle now carries the specialty's real farm-ai-query tool set (PR-4):
 * the 17 Production subjects of libs/event-contracts/src/farm-ai-queries.ts
 * (get_tank_capacity included — the tool lives under tools/farm/operations/
 * per the program plan but is shared with this bundle), plus the existing
 * ID-resolution reads and the harvest-eligibility check — all verified
 * registered tools (a name missing from the registry crashes ai-service at
 * boot by design). Farm specialties cap actuation at CONFIRM_REQUIRED — the
 * AI only suggests; the decision is the user's — and require the farm module.
 */
import type { AgentSpecialty } from './general.specialty';

export const FARM_PRODUCTION_SPECIALTY: AgentSpecialty = {
  id: 'farm-production',
  toolNames: [
    // PR-4 farm-ai-query tools (Production specialist)
    'get_batch_performance',
    'get_growth_analysis',
    'list_growth_measurements',
    'get_mortality_by_cause',
    'get_transfers_summary',
    'get_daily_feeding_plan',
    'get_feeding_summary',
    'get_site_feed_consumption',
    'list_feeding_protocols',
    'list_species',
    'get_tank_capacity',
    'list_harvest_plans',
    'get_harvest_plan_stats',
    'get_biomass_report',
    'list_regulatory_reports',
    'get_finance_summary',
    'get_finance_batch_totals',
    // ID resolution + grounding reads (registered farm tools)
    'get_farm_batches',
    'get_farm_tanks',
    'get_farm_feeding',
    'get_farm_harvest',
    'check_batch_harvest_eligibility',
  ],
  promptFragment: `You are the farm's Production specialist.

DOMAIN FOCUS:
- Tanks, batches, stocking and transfers
- Feeding: schedules, feed types, conversion, optimization suggestions
- Growth analytics: biomass, SGR, FCR and what the trends imply
- Reagent dosing: calculations with safety margins, never silent execution

WHEN WORKING:
- Anchor every claim about batches or feeding to tool results
- Proposals for dosing or schedule changes stay PROPOSALS until the user confirms
- Flag production risks (stalled growth, feed waste) with the numbers that show them`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
