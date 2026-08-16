/**
 * Cross-runtime billing metric vocabulary.
 *
 * This is the sole authority for metric codes, labels, units, metering mode,
 * and the module-quantity field consumed by pricing calculators and admin UIs.
 */
export const PricingMetricType = Object.freeze({
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
} as const);

export type PricingMetricType = (typeof PricingMetricType)[keyof typeof PricingMetricType];

export interface PricingModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
  workflows?: number;
}

export type PricingModuleQuantityField = keyof PricingModuleQuantities;

interface PricingMetricCatalogEntry {
  readonly label: string;
  readonly unit: string;
  readonly mode: 'fixed' | 'usage';
  readonly quantityField: PricingModuleQuantityField | null;
}

export const PRICING_METRIC_CATALOG = Object.freeze({
  [PricingMetricType.BASE_PRICE]: {
    label: 'Base Price',
    unit: '/month',
    mode: 'fixed',
    quantityField: null,
  },
  [PricingMetricType.PER_USER]: {
    label: 'Per User',
    unit: '/user/month',
    mode: 'fixed',
    quantityField: 'users',
  },
  [PricingMetricType.PER_FARM]: {
    label: 'Per Farm',
    unit: '/farm/month',
    mode: 'fixed',
    quantityField: 'farms',
  },
  [PricingMetricType.PER_POND]: {
    label: 'Per Pond/Tank',
    unit: '/pond/month',
    mode: 'fixed',
    quantityField: 'ponds',
  },
  [PricingMetricType.PER_SENSOR]: {
    label: 'Per Sensor',
    unit: '/sensor/month',
    mode: 'fixed',
    quantityField: 'sensors',
  },
  [PricingMetricType.PER_DEVICE]: {
    label: 'Per Device',
    unit: '/device/month',
    mode: 'fixed',
    quantityField: 'devices',
  },
  [PricingMetricType.PER_GB_STORAGE]: {
    label: 'Per GB Storage',
    unit: '/GB/month',
    mode: 'fixed',
    quantityField: 'storageGb',
  },
  [PricingMetricType.PER_GB_TRANSFER]: {
    label: 'Per GB Transfer',
    unit: '/GB',
    mode: 'usage',
    quantityField: null,
  },
  [PricingMetricType.PER_API_CALL]: {
    label: 'Per API Call',
    unit: '/call',
    mode: 'usage',
    quantityField: 'apiCalls',
  },
  [PricingMetricType.PER_ALERT]: {
    label: 'Per Alert',
    unit: '/alert',
    mode: 'usage',
    quantityField: 'alerts',
  },
  [PricingMetricType.PER_REPORT]: {
    label: 'Per Report',
    unit: '/report',
    mode: 'usage',
    quantityField: 'reports',
  },
  [PricingMetricType.PER_SMS]: {
    label: 'Per SMS',
    unit: '/SMS',
    mode: 'usage',
    quantityField: null,
  },
  [PricingMetricType.PER_EMAIL]: {
    label: 'Per Email',
    unit: '/email',
    mode: 'usage',
    quantityField: null,
  },
  [PricingMetricType.PER_INTEGRATION]: {
    label: 'Per Integration',
    unit: '/integration/month',
    mode: 'fixed',
    quantityField: 'integrations',
  },
  [PricingMetricType.PER_WORKFLOW]: {
    label: 'Per Workflow',
    unit: '/workflow/month',
    mode: 'fixed',
    quantityField: 'workflows',
  },
} as const satisfies Readonly<Record<PricingMetricType, PricingMetricCatalogEntry>>);

export const PricingMetricLabels = Object.freeze(
  Object.fromEntries(
    Object.entries(PRICING_METRIC_CATALOG).map(([metric, entry]) => [metric, entry.label]),
  ) as Record<PricingMetricType, string>,
);

export const PricingMetricUnits = Object.freeze(
  Object.fromEntries(
    Object.entries(PRICING_METRIC_CATALOG).map(([metric, entry]) => [metric, entry.unit]),
  ) as Record<PricingMetricType, string>,
);

export const UsageBasedMetrics = Object.freeze(
  Object.entries(PRICING_METRIC_CATALOG)
    .filter(([, entry]) => entry.mode === 'usage')
    .map(([metric]) => metric as PricingMetricType),
);

export const FixedMetrics = Object.freeze(
  Object.entries(PRICING_METRIC_CATALOG)
    .filter(([, entry]) => entry.mode === 'fixed')
    .map(([metric]) => metric as PricingMetricType),
);
