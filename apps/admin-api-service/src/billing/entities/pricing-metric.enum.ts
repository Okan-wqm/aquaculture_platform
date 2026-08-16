/**
 * Compatibility-free domain export: the cross-runtime vocabulary is the one
 * authority; persistence and services import it through this domain boundary.
 */
export {
  FixedMetrics,
  PRICING_METRIC_CATALOG,
  PricingMetricLabels,
  PricingMetricType,
  PricingMetricUnits,
  UsageBasedMetrics,
  type PricingModuleQuantities,
  type PricingModuleQuantityField,
} from '@platform/pricing-metric-vocabulary';
