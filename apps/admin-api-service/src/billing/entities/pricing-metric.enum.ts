/**
 * Pricing Metric Types
 *
 * Defines all available pricing metrics for modular billing.
 * Each module can have multiple pricing metrics.
 */
export enum PricingMetricType {
  // Base pricing
  BASE_PRICE = 'base_price',           // Module base fee (monthly)

  // Per-unit pricing
  PER_USER = 'per_user',               // Per active user
  PER_FARM = 'per_farm',               // Per farm/site
  PER_POND = 'per_pond',               // Per pond/tank
  PER_SENSOR = 'per_sensor',           // Per connected sensor
  PER_DEVICE = 'per_device',           // Per IoT device

  // Storage & data
  PER_GB_STORAGE = 'per_gb_storage',   // Per GB of storage
  PER_GB_TRANSFER = 'per_gb_transfer', // Per GB data transfer

  // Usage-based
  PER_API_CALL = 'per_api_call',       // Per API call (for integrations)
  PER_ALERT = 'per_alert',             // Per alert/notification sent
  PER_REPORT = 'per_report',           // Per generated report
  PER_SMS = 'per_sms',                 // Per SMS notification
  PER_EMAIL = 'per_email',             // Per email notification

  // Advanced features
  PER_INTEGRATION = 'per_integration', // Per external integration
  PER_WORKFLOW = 'per_workflow',       // Per automated workflow
}

/**
 * Human-readable labels for pricing metrics
 */
export const PricingMetricLabels: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: 'Base Price',
  [PricingMetricType.PER_USER]: 'Per User',
  [PricingMetricType.PER_FARM]: 'Per Farm',
  [PricingMetricType.PER_POND]: 'Per Pond/Tank',
  [PricingMetricType.PER_SENSOR]: 'Per Sensor',
  [PricingMetricType.PER_DEVICE]: 'Per Device',
  [PricingMetricType.PER_GB_STORAGE]: 'Per GB Storage',
  [PricingMetricType.PER_GB_TRANSFER]: 'Per GB Transfer',
  [PricingMetricType.PER_API_CALL]: 'Per API Call',
  [PricingMetricType.PER_ALERT]: 'Per Alert',
  [PricingMetricType.PER_REPORT]: 'Per Report',
  [PricingMetricType.PER_SMS]: 'Per SMS',
  [PricingMetricType.PER_EMAIL]: 'Per Email',
  [PricingMetricType.PER_INTEGRATION]: 'Per Integration',
  [PricingMetricType.PER_WORKFLOW]: 'Per Workflow',
};

/**
 * Metric units for display
 */
export const PricingMetricUnits: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: '/month',
  [PricingMetricType.PER_USER]: '/user/month',
  [PricingMetricType.PER_FARM]: '/farm/month',
  [PricingMetricType.PER_POND]: '/pond/month',
  [PricingMetricType.PER_SENSOR]: '/sensor/month',
  [PricingMetricType.PER_DEVICE]: '/device/month',
  [PricingMetricType.PER_GB_STORAGE]: '/GB/month',
  [PricingMetricType.PER_GB_TRANSFER]: '/GB',
  [PricingMetricType.PER_API_CALL]: '/call',
  [PricingMetricType.PER_ALERT]: '/alert',
  [PricingMetricType.PER_REPORT]: '/report',
  [PricingMetricType.PER_SMS]: '/SMS',
  [PricingMetricType.PER_EMAIL]: '/email',
  [PricingMetricType.PER_INTEGRATION]: '/integration/month',
  [PricingMetricType.PER_WORKFLOW]: '/workflow/month',
};

/**
 * Metrics that are usage-based (metered) vs fixed
 */
export const UsageBasedMetrics: PricingMetricType[] = [
  PricingMetricType.PER_API_CALL,
  PricingMetricType.PER_ALERT,
  PricingMetricType.PER_REPORT,
  PricingMetricType.PER_SMS,
  PricingMetricType.PER_EMAIL,
  PricingMetricType.PER_GB_TRANSFER,
];

/**
 * Metrics that are fixed per billing period
 */
export const FixedMetrics: PricingMetricType[] = [
  PricingMetricType.BASE_PRICE,
  PricingMetricType.PER_USER,
  PricingMetricType.PER_FARM,
  PricingMetricType.PER_POND,
  PricingMetricType.PER_SENSOR,
  PricingMetricType.PER_DEVICE,
  PricingMetricType.PER_GB_STORAGE,
  PricingMetricType.PER_INTEGRATION,
  PricingMetricType.PER_WORKFLOW,
];
