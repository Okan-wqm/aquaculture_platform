/**
 * BillingPricingMetricType — what a module charges for (ADR-0013).
 *
 * The metric set was declared in `apps/admin-api-service/src/billing/entities/
 * pricing-metric.enum.ts` while the prices themselves moved to `billing`,
 * which would have left the enum in one service and the rows it labels in
 * another. It is a billing concept that crosses the service boundary, so it
 * lives in the contract; both services import it, and the admin-panel gets it
 * through the generated OpenAPI client (web modules never bundle a backend
 * library — see the FE parity guard).
 *
 * A union of string literals, not a TypeScript `enum`: enum members are
 * nominal and are not assignable to the strings the API actually exchanges,
 * which is the drift `DiscountType` and `TenantProvisioningState` were caught
 * in when the generated client landed (CONTRACT-CRITICAL-003).
 */
export type BillingPricingMetricType =
  // Base pricing
  | 'base_price'
  // Per-unit pricing
  | 'per_user'
  | 'per_farm'
  | 'per_pond'
  | 'per_sensor'
  | 'per_device'
  // Storage & data
  | 'per_gb_storage'
  | 'per_gb_transfer'
  // Usage-based
  | 'per_api_call'
  | 'per_alert'
  | 'per_report'
  | 'per_sms'
  | 'per_email'
  // Advanced features
  | 'per_integration'
  | 'per_workflow';

/** Every member, in declaration order — the list a validator and a DB CHECK share. */
export const BILLING_PRICING_METRIC_TYPES: readonly BillingPricingMetricType[] = [
  'base_price',
  'per_user',
  'per_farm',
  'per_pond',
  'per_sensor',
  'per_device',
  'per_gb_storage',
  'per_gb_transfer',
  'per_api_call',
  'per_alert',
  'per_report',
  'per_sms',
  'per_email',
  'per_integration',
  'per_workflow',
] as const;

/** Named members, for call sites that read better with a name than a literal. */
export const BillingPricingMetricType = {
  BASE_PRICE: 'base_price',
  PER_USER: 'per_user',
  PER_FARM: 'per_farm',
  PER_POND: 'per_pond',
  PER_SENSOR: 'per_sensor',
  PER_DEVICE: 'per_device',
  PER_GB_STORAGE: 'per_gb_storage',
  PER_GB_TRANSFER: 'per_gb_transfer',
  PER_API_CALL: 'per_api_call',
  PER_ALERT: 'per_alert',
  PER_REPORT: 'per_report',
  PER_SMS: 'per_sms',
  PER_EMAIL: 'per_email',
  PER_INTEGRATION: 'per_integration',
  PER_WORKFLOW: 'per_workflow',
} as const satisfies Record<string, BillingPricingMetricType>;

export const BILLING_PRICING_METRIC_LABELS: Readonly<Record<BillingPricingMetricType, string>> = {
  base_price: 'Base Price',
  per_user: 'Per User',
  per_farm: 'Per Farm',
  per_pond: 'Per Pond/Tank',
  per_sensor: 'Per Sensor',
  per_device: 'Per Device',
  per_gb_storage: 'Per GB Storage',
  per_gb_transfer: 'Per GB Transfer',
  per_api_call: 'Per API Call',
  per_alert: 'Per Alert',
  per_report: 'Per Report',
  per_sms: 'Per SMS',
  per_email: 'Per Email',
  per_integration: 'Per Integration',
  per_workflow: 'Per Workflow',
};

export const BILLING_PRICING_METRIC_UNITS: Readonly<Record<BillingPricingMetricType, string>> = {
  base_price: '/month',
  per_user: '/user/month',
  per_farm: '/farm/month',
  per_pond: '/pond/month',
  per_sensor: '/sensor/month',
  per_device: '/device/month',
  per_gb_storage: '/GB/month',
  per_gb_transfer: '/GB',
  per_api_call: '/call',
  per_alert: '/alert',
  per_report: '/report',
  per_sms: '/SMS',
  per_email: '/email',
  per_integration: '/integration/month',
  per_workflow: '/workflow/month',
};

/** Metered after the fact; billed on measured usage rather than a fixed count. */
export const BILLING_USAGE_BASED_METRICS: readonly BillingPricingMetricType[] = [
  'per_api_call',
  'per_alert',
  'per_report',
  'per_sms',
  'per_email',
  'per_gb_transfer',
];

/** Fixed per billing period; billed on the subscribed quantity. */
export const BILLING_FIXED_METRICS: readonly BillingPricingMetricType[] = [
  'base_price',
  'per_user',
  'per_farm',
  'per_pond',
  'per_sensor',
  'per_device',
  'per_gb_storage',
  'per_integration',
  'per_workflow',
];

/**
 * The quantity fields a module selection can carry. Declared here rather than
 * derived from `BillingModuleQuantities` so the metric → field map is typed by
 * the same names it indexes, instead of by `string` (which forced a cast at
 * every read).
 */
export type BillingModuleQuantityField =
  | 'users'
  | 'farms'
  | 'ponds'
  | 'sensors'
  | 'employees'
  | 'devices'
  | 'storageGb'
  | 'apiCalls'
  | 'alerts'
  | 'reports'
  | 'integrations';

/**
 * Which quantity of a module selection a metric bills against. `base_price`
 * has none — it is charged once per module.
 */
export const BILLING_METRIC_QUANTITY_FIELD: Readonly<
  Partial<Record<BillingPricingMetricType, BillingModuleQuantityField>>
> = {
  per_user: 'users',
  per_farm: 'farms',
  per_pond: 'ponds',
  per_sensor: 'sensors',
  per_device: 'devices',
  per_gb_storage: 'storageGb',
  per_api_call: 'apiCalls',
  per_alert: 'alerts',
  per_report: 'reports',
  per_integration: 'integrations',
};
