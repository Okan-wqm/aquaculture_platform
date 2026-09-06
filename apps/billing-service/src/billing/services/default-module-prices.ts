/**
 * The default price sheet per module (ADR-0013, BILLING-CRITICAL-002).
 *
 * Moved from `apps/admin-api-service/src/billing/data/default-module-pricing.ts`
 * with the sheet it seeds. Every price is an exact decimal STRING, not a
 * `number` literal: 0.02 as a double is 0.020000000000000000416…, and a
 * per-alert price multiplied by a thousand alerts is exactly where that
 * matters.
 *
 * Tier multipliers: STARTER is full price, PROFESSIONAL 10% off, ENTERPRISE
 * and CUSTOM 30% off. FREE is absent on purpose — it is permanently $0 by
 * rule (`priceModule` short-circuits it), not by a multiplier that a sheet
 * might forget to declare.
 */
import { BillingPlanTier } from '@platform/event-contracts';
import type {
  BillingModulePriceInput,
  BillingModulePriceTierMultiplierInput,
} from '@platform/event-contracts';

const DEFAULT_TIER_MULTIPLIERS: readonly BillingModulePriceTierMultiplierInput[] = [
  { tier: BillingPlanTier.STARTER, multiplier: '1' },
  { tier: BillingPlanTier.PROFESSIONAL, multiplier: '0.9' },
  { tier: BillingPlanTier.ENTERPRISE, multiplier: '0.7' },
  { tier: BillingPlanTier.CUSTOM, multiplier: '0.7' },
];

/** A template minus the identity the caller supplies (`moduleId`, `moduleCode`). */
type DefaultSheet = Omit<BillingModulePriceInput, 'moduleId' | 'moduleCode'>;

function sheet(metrics: BillingModulePriceInput['metrics']): DefaultSheet {
  return { currency: 'USD', metrics, tierMultipliers: [...DEFAULT_TIER_MULTIPLIERS] };
}

export const DEFAULT_MODULE_PRICES: Readonly<Record<string, DefaultSheet>> = {
  farm: sheet([
    {
      metricType: 'base_price',
      price: '50',
      description: 'Base monthly fee for Farm Management module',
    },
    {
      metricType: 'per_user',
      price: '10',
      description: 'Per active user',
      minQuantity: 1,
      includedQuantity: 2,
    },
    {
      metricType: 'per_farm',
      price: '25',
      description: 'Per farm/site',
      minQuantity: 1,
      includedQuantity: 1,
    },
    {
      metricType: 'per_pond',
      price: '5',
      description: 'Per pond/tank',
      includedQuantity: 10,
    },
    {
      metricType: 'per_report',
      price: '0.5',
      description: 'Per generated analytics report',
      includedQuantity: 50,
    },
  ]),

  hr: sheet([
    {
      metricType: 'base_price',
      price: '40',
      description: 'Base monthly fee for HR Management',
    },
    {
      metricType: 'per_user',
      price: '8',
      description: 'Per employee managed',
      includedQuantity: 10,
    },
    {
      metricType: 'per_report',
      price: '0.25',
      description: 'Per HR analytics report',
      includedQuantity: 30,
    },
  ]),

  sensor: sheet([
    {
      metricType: 'base_price',
      price: '75',
      description: 'Base monthly fee for Sensor Monitoring module',
    },
    {
      metricType: 'per_user',
      price: '10',
      description: 'Per active user',
      minQuantity: 1,
      includedQuantity: 2,
    },
    {
      metricType: 'per_sensor',
      price: '2',
      description: 'Per connected sensor',
      includedQuantity: 10,
    },
    {
      metricType: 'per_device',
      price: '5',
      description: 'Per IoT gateway device',
      includedQuantity: 2,
    },
    {
      metricType: 'per_gb_storage',
      price: '0.5',
      description: 'Per GB of sensor data storage (TimescaleDB)',
      includedQuantity: 10,
    },
    {
      metricType: 'per_alert',
      price: '0.02',
      description: 'Per alert triggered',
      includedQuantity: 1000,
    },
    {
      metricType: 'per_report',
      price: '0.5',
      description: 'Per sensor analytics report',
      includedQuantity: 30,
    },
  ]),

  hydroponics: sheet([
    {
      metricType: 'base_price',
      price: '45',
      description: 'Base monthly fee for Hydroponics module',
    },
    {
      metricType: 'per_user',
      price: '10',
      description: 'Per active user',
      minQuantity: 1,
      includedQuantity: 2,
    },
    {
      metricType: 'per_farm',
      price: '20',
      description: 'Per hydroponic system/facility',
      minQuantity: 1,
      includedQuantity: 1,
    },
    {
      metricType: 'per_pond',
      price: '3',
      description: 'Per growing bed/channel',
      includedQuantity: 10,
    },
    {
      metricType: 'per_report',
      price: '0.5',
      description: 'Per analytics report',
      includedQuantity: 30,
    },
  ]),
};
