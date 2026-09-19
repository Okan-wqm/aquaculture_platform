import type { AgentSpecialty } from '../types';

/**
 * Production specialist (farm module): batches, growth, species targets, tank
 * capacity, feeding, harvest planning (with eligibility), regulatory biomass
 * reports and finance (manager+). Advises only; the actuation cap keeps every
 * write behind human confirmation.
 */
export const FARM_PRODUCTION_SPECIALTY: AgentSpecialty = {
  id: 'farm-production',
  toolNames: [
    'get_farm_tanks',
    'get_farm_batches',
    'get_farm_feeding',
    'get_farm_harvest',
    'list_species',
    'get_tank_capacity',
    'get_batch_performance',
    'get_growth_analysis',
    'list_growth_measurements',
    'get_mortality_by_cause',
    'get_transfers_summary',
    'get_daily_feeding_plan',
    'get_feeding_summary',
    'get_site_feed_consumption',
    'list_feeding_protocols',
    'list_harvest_plans',
    'get_harvest_plan_stats',
    'check_batch_harvest_eligibility',
    'get_biomass_report',
    'list_regulatory_reports',
    'get_finance_summary',
    'get_finance_batch_totals',
    'calculate_growth_metrics',
    'predict_feeding_impact',
    'calculate_carrying_capacity',
  ],
  promptFragment: `DOMAIN: production performance for this farm — batches, growth, feeding, harvest, biomass reporting and production cost.
- Start from the data: resolve tanks/batches with get_farm_tanks and get_farm_batches, then read performance, growth, feeding and harvest tools before interpreting.
- Compare SGR, FCR, mortality and biomass against the species targets and the batch's own history; quantify deviations and their cost.
- For feeding, tie planned vs actual consumption to growth response before recommending a change.
- For harvest, check plans, eligibility (withdrawal periods) and biomass together.
- Water chemistry and disease diagnosis belong to the Water & Fish Health specialist; maintenance, equipment and stock to the Farm Operations specialist.`,
  actuationCap: 'confirm_required',
  requiresModule: 'farm',
};
