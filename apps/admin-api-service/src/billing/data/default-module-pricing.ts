import { PricingMetricType } from '../entities/pricing-metric.enum';
import { PlanTier } from '../entities/plan-definition.entity';
import { PricingMetric, TierMultipliers } from '../entities/module-pricing.entity';

/**
 * Default module pricing configuration
 *
 * This defines the base pricing for each system module.
 * Prices are in USD and per month unless otherwise noted.
 *
 * Updated: 3 core modules only (Farm, HR, Sensor)
 */
export interface DefaultModulePricingData {
  moduleCode: string;
  moduleName: string;
  metrics: PricingMetric[];
  tierMultipliers: TierMultipliers;
}

/**
 * Default tier multipliers
 * STARTER = full price
 * PROFESSIONAL = 10% discount
 * ENTERPRISE = 30% discount
 * CUSTOM = negotiated (defaults to enterprise)
 */
export const DEFAULT_TIER_MULTIPLIERS: TierMultipliers = {
  [PlanTier.STARTER]: 1.0,
  [PlanTier.PROFESSIONAL]: 0.9,
  [PlanTier.ENTERPRISE]: 0.7,
  [PlanTier.CUSTOM]: 0.7,
};

/**
 * Default pricing for all modules
 * Updated: Only 3 core modules (Farm, HR, Sensor)
 */
export const DEFAULT_MODULE_PRICING: DefaultModulePricingData[] = [
  // ============================================
  // Farm Management Module
  // Includes: farms, sites, tanks, batches, species, feeding,
  // growth, water-quality, fish-health, harvest, maintenance,
  // equipment, suppliers, chemicals, feeds, inventory, analytics
  // ============================================
  {
    moduleCode: 'farm',
    moduleName: 'Balık Çiftliği Yönetimi',
    metrics: [
      {
        type: PricingMetricType.BASE_PRICE,
        price: 50,
        currency: 'USD',
        description: 'Base monthly fee for Farm Management module',
      },
      {
        type: PricingMetricType.PER_USER,
        price: 10,
        currency: 'USD',
        description: 'Per active user',
        minQuantity: 1,
        includedQuantity: 2, // 2 users included in base
      },
      {
        type: PricingMetricType.PER_FARM,
        price: 25,
        currency: 'USD',
        description: 'Per farm/site',
        minQuantity: 1,
        includedQuantity: 1, // 1 farm included in base
      },
      {
        type: PricingMetricType.PER_POND,
        price: 5,
        currency: 'USD',
        description: 'Per pond/tank',
        includedQuantity: 10, // 10 tanks included
      },
      {
        type: PricingMetricType.PER_REPORT,
        price: 0.5,
        currency: 'USD',
        description: 'Per generated analytics report',
        includedQuantity: 50, // 50 reports included
      },
    ],
    tierMultipliers: DEFAULT_TIER_MULTIPLIERS,
  },

  // ============================================
  // HR Management Module
  // Includes: employees, departments, attendance, leaves,
  // payroll, performance, training, certifications, scheduling, analytics
  // ============================================
  {
    moduleCode: 'hr',
    moduleName: 'İnsan Kaynakları',
    metrics: [
      {
        type: PricingMetricType.BASE_PRICE,
        price: 40,
        currency: 'USD',
        description: 'Base monthly fee for HR Management',
      },
      {
        type: PricingMetricType.PER_USER,
        price: 8,
        currency: 'USD',
        description: 'Per employee managed',
        includedQuantity: 10, // 10 employees included
      },
      {
        type: PricingMetricType.PER_REPORT,
        price: 0.25,
        currency: 'USD',
        description: 'Per HR analytics report',
        includedQuantity: 30, // 30 reports included
      },
    ],
    tierMultipliers: DEFAULT_TIER_MULTIPLIERS,
  },

  // ============================================
  // Sensor Monitoring Module
  // Includes: devices, readings, alerts, calibration,
  // thresholds, analytics, trends, reports
  // ============================================
  {
    moduleCode: 'sensor',
    moduleName: 'Sensör İzleme',
    metrics: [
      {
        type: PricingMetricType.BASE_PRICE,
        price: 75,
        currency: 'USD',
        description: 'Base monthly fee for Sensor Monitoring module',
      },
      {
        type: PricingMetricType.PER_USER,
        price: 10,
        currency: 'USD',
        description: 'Per active user',
        minQuantity: 1,
        includedQuantity: 2, // 2 users included
      },
      {
        type: PricingMetricType.PER_SENSOR,
        price: 2,
        currency: 'USD',
        description: 'Per connected sensor',
        includedQuantity: 10, // 10 sensors included
      },
      {
        type: PricingMetricType.PER_DEVICE,
        price: 5,
        currency: 'USD',
        description: 'Per IoT gateway device',
        includedQuantity: 2, // 2 devices included
      },
      {
        type: PricingMetricType.PER_GB_STORAGE,
        price: 0.5,
        currency: 'USD',
        description: 'Per GB of sensor data storage (TimescaleDB)',
        includedQuantity: 10, // 10GB included
      },
      {
        type: PricingMetricType.PER_ALERT,
        price: 0.02,
        currency: 'USD',
        description: 'Per alert triggered',
        includedQuantity: 1000, // 1000 alerts included
      },
      {
        type: PricingMetricType.PER_REPORT,
        price: 0.5,
        currency: 'USD',
        description: 'Per sensor analytics report',
        includedQuantity: 30, // 30 reports included
      },
    ],
    tierMultipliers: DEFAULT_TIER_MULTIPLIERS,
  },
];

/**
 * Get pricing data for a specific module
 */
export function getModulePricingData(
  moduleCode: string,
): DefaultModulePricingData | undefined {
  return DEFAULT_MODULE_PRICING.find((m) => m.moduleCode === moduleCode);
}

/**
 * Get all module codes with pricing
 */
export function getAllPricedModuleCodes(): string[] {
  return DEFAULT_MODULE_PRICING.map((m) => m.moduleCode);
}
