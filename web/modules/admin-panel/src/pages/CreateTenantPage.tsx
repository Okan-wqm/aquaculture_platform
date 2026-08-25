/**
 * Create Tenant Page - Modular Pricing Edition
 *
 * Multi-step tenant creation wizard with:
 * - Module selection with metric-based pricing
 * - Real-time price calculation
 * - Custom pricing per tenant (no fixed plans)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Badge, Input, Select, Alert, RadioGroup } from '@aquaculture/shared-ui';
import {
  tenantsApi,
  modulesApi,
  billingApi,
  PricingMetricType,
  TenantTier,
  TenantProvisioningState,
  PlanTier,
  BillingCycle,
  type SystemModule,
  type CreateTenantDto,
  type CreateTenantAcceptedResponse,
  type ModulePricingWithModule,
  type ModuleQuantities,
  type ModuleSelection,
  type PricingCalculation,
  type QuoteRequest,
} from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

// Tier'ı burada tanımlıyoruz (fix plan yok, sadece indirim oranları için)
type PricingTier = 'free' | 'starter' | 'professional' | 'enterprise' | 'custom';

// Selectable pricing tiers surfaced in the wizard (Billing Revival Faz B). FREE
// is a permanent $0 tier; the paid tiers keep their existing pricing behaviour.
const TIER_OPTIONS: { value: PricingTier; label: string; description: string }[] = [
  { value: 'free', label: 'Free', description: 'Permanent $0 — no platform or module fees' },
  { value: 'starter', label: 'Starter', description: 'Small farms getting started' },
  {
    value: 'professional',
    label: 'Professional',
    description: 'Growing operations — reports + API access',
  },
  { value: 'enterprise', label: 'Enterprise', description: 'Unlimited scale, every capability' },
];

// FREE-tier allowances surfaced when Free is selected. This is descriptive UI
// copy only — the authoritative limits are enforced server-side by the canonical
// PLAN_CATALOG FREE entry (billing.subscriptions.limits). Kept here because web
// modules do not import @platform/event-contracts.
const FREE_TIER_LIMITS = {
  maxUsers: 3,
  maxFarms: 1,
  maxPonds: 5,
  maxSensors: 10,
  dataRetentionDays: 30,
} as const;

interface ModuleConfig {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  enabled: boolean;
  quantities: ModuleQuantities;
}

interface TenantFormData {
  // Step 1: Basic Info
  name: string;
  slug: string;
  description: string;
  domain: string;
  country: string;
  region: string;
  sustainedIngressMessagesPerSecond: number;
  sustainedMetricRowsPerMinute: number;

  // Step 2: Contact Info
  primaryContact: {
    name: string;
    email: string;
    phone: string;
  };
  billingEmail: string;

  // Step 3: Modules & Pricing
  moduleConfigs: ModuleConfig[];
  pricingTier: PricingTier;

  // Step 4: Trial settings
  trialDays: number;
  maxStorage: number;
}

const initialFormData: TenantFormData = {
  name: '',
  slug: '',
  description: '',
  domain: '',
  country: '',
  region: '',
  sustainedIngressMessagesPerSecond: 20,
  sustainedMetricRowsPerMinute: 1200,
  primaryContact: {
    name: '',
    email: '',
    phone: '',
  },
  billingEmail: '',
  moduleConfigs: [],
  pricingTier: 'starter',
  trialDays: 14,
  maxStorage: -1,
};

// Helper to check if metric is BASE_PRICE (handles both string and enum)
const isBasePrice = (metricType: string | PricingMetricType): boolean => {
  return metricType === 'BASE_PRICE' || metricType === PricingMetricType.BASE_PRICE;
};

// Single source of truth for metric labels (BUG-018: removed duplicate getMetricLabel)
const metricLabels: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: 'Base Price',
  [PricingMetricType.PER_USER]: 'Per User',
  [PricingMetricType.PER_FARM]: 'Per Farm',
  [PricingMetricType.PER_POND]: 'Per Pond',
  [PricingMetricType.PER_SENSOR]: 'Per Sensors',
  [PricingMetricType.PER_DEVICE]: 'Per Device',
  [PricingMetricType.PER_GB_STORAGE]: 'Per GB Storage',
  [PricingMetricType.PER_API_CALL]: 'Per API Call',
  [PricingMetricType.PER_ALERT]: 'Per Alert',
  [PricingMetricType.PER_REPORT]: 'Per Report',
  [PricingMetricType.PER_SMS]: 'Per SMS',
  [PricingMetricType.PER_EMAIL]: 'Per Email',
  [PricingMetricType.PER_INTEGRATION]: 'Per Integration',
};

// Single source of truth for metric → quantity field mapping (BUG-018: removed duplicate getQuantityField)
const metricToQuantityField: Record<PricingMetricType, keyof ModuleQuantities | null> = {
  [PricingMetricType.BASE_PRICE]: null,
  [PricingMetricType.PER_USER]: 'users',
  [PricingMetricType.PER_FARM]: 'farms',
  [PricingMetricType.PER_POND]: 'ponds',
  [PricingMetricType.PER_SENSOR]: 'sensors',
  [PricingMetricType.PER_DEVICE]: 'devices',
  [PricingMetricType.PER_GB_STORAGE]: 'storageGb',
  [PricingMetricType.PER_API_CALL]: 'apiCalls',
  [PricingMetricType.PER_ALERT]: 'alerts',
  [PricingMetricType.PER_REPORT]: 'reports',
  [PricingMetricType.PER_SMS]: null,
  [PricingMetricType.PER_EMAIL]: null,
  [PricingMetricType.PER_INTEGRATION]: 'integrations',
};

// Derived helpers that use the single source of truth
const getMetricLabel = (metricType: string | PricingMetricType): string =>
  metricLabels[metricType as PricingMetricType] || metricType;

const getQuantityField = (metricType: string | PricingMetricType): keyof ModuleQuantities | null =>
  metricToQuantityField[metricType as PricingMetricType] ?? null;

const TENANT_CREATE_IDEMPOTENCY_PREFIX = 'admin-panel:tenant-create:idempotency:';

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const getTenantCreateIdempotency = (
  payload: CreateTenantDto,
): { key: string; storageKey?: string } => {
  const storageKey = `${TENANT_CREATE_IDEMPOTENCY_PREFIX}${hashString(stableStringify(payload))}`;

  if (typeof window === 'undefined') {
    return { key: crypto.randomUUID() };
  }

  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) {
    return { key: existing, storageKey };
  }

  const key = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, key);
  return { key, storageKey };
};

// ============================================================================
// Step Indicator Component
// ============================================================================

const StepIndicator: React.FC<{
  steps: { label: string; description: string }[];
  currentStep: number;
}> = ({ steps, currentStep }) => (
  <div className="mb-8">
    <div className="flex items-center justify-between">
      {steps.map((step, index) => (
        <React.Fragment key={index}>
          <div className="flex flex-col items-center">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                index < currentStep
                  ? 'bg-green-500 text-white'
                  : index === currentStep
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-200 text-gray-500'
              }`}
            >
              {index < currentStep ? (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              ) : (
                index + 1
              )}
            </div>
            <div className="mt-2 text-center">
              <p
                className={`text-sm font-medium ${index <= currentStep ? 'text-gray-900' : 'text-gray-500'}`}
              >
                {step.label}
              </p>
              <p className="text-xs text-gray-500 hidden sm:block">{step.description}</p>
            </div>
          </div>
          {index < steps.length - 1 && (
            <div
              className={`flex-1 h-1 mx-4 rounded ${
                index < currentStep ? 'bg-green-500' : 'bg-gray-200'
              }`}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  </div>
);

// ============================================================================
// Module Configuration Card
// ============================================================================

interface ModuleConfigCardProps {
  config: ModuleConfig;
  pricing: ModulePricingWithModule | undefined;
  onToggle: () => void;
  onQuantityChange: (field: keyof ModuleQuantities, value: number) => void;
}

const ModuleConfigCard: React.FC<ModuleConfigCardProps> = ({
  config,
  pricing,
  onToggle,
  onQuantityChange,
}) => {
  const metrics = pricing?.pricingMetrics || [];

  return (
    <Card
      className={`p-4 transition-all ${config.enabled ? 'ring-2 ring-indigo-500 bg-indigo-50/50' : 'bg-white'}`}
    >
      {/* Module Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label={`${config.enabled ? 'Disable' : 'Enable'} ${config.moduleName}`}
            onClick={onToggle}
            className={`mt-1 w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
              config.enabled
                ? 'bg-indigo-600 border-indigo-600'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            {config.enabled && (
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={3}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </button>
          <div>
            <h4 className="font-semibold text-gray-900">{config.moduleName}</h4>
            <p className="text-xs text-gray-500">{config.moduleCode}</p>
          </div>
        </div>
        {config.enabled && (
          <Badge variant="success" size="sm">
            Active
          </Badge>
        )}
      </div>

      {/* Metric Inputs - Only show when enabled */}
      {config.enabled && metrics.length > 0 && (
        <div className="space-y-3 pt-3 border-t border-gray-200">
          {metrics.map((metric) => {
            const quantityField = getQuantityField(metric.type);

            // BASE_PRICE doesn't need quantity input
            if (isBasePrice(metric.type)) {
              return (
                <div key={metric.type} className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-600">{getMetricLabel(metric.type)}</span>
                  <span className="text-sm font-semibold text-indigo-600">
                    ${(metric.price || 0).toFixed(2)}/mo
                  </span>
                </div>
              );
            }

            if (!quantityField) return null;

            const includedQty = metric.includedQuantity ?? 0;
            const minQty = Math.max(metric.minQuantity ?? 0, 0);
            const currentValue = Math.max(config.quantities[quantityField] ?? minQty, minQty);
            const unitPrice = metric.price || 0;
            const extraQty = Math.max(0, currentValue - includedQty);

            return (
              <div key={metric.type} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-gray-600">
                    {getMetricLabel(metric.type)}
                    {includedQty > 0 && (
                      <span className="text-xs text-green-600 ml-1">({includedQty} included)</span>
                    )}
                  </label>
                  <span className="text-xs text-gray-500">${unitPrice.toFixed(2)}/unit</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={minQty}
                    max={metric.maxQuantity || 9999}
                    value={currentValue}
                    onChange={(e) => {
                      const parsedValue = Number.parseInt(e.target.value, 10);
                      const newValue = Number.isNaN(parsedValue) ? minQty : parsedValue;
                      onQuantityChange(quantityField, Math.max(newValue, minQty));
                    }}
                    className="w-24 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">units</span>
                  {extraQty > 0 && (
                    <span className="text-sm font-medium text-indigo-600 ml-auto">
                      +${(extraQty * unitPrice).toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* No pricing info message */}
      {config.enabled && metrics.length === 0 && (
        <p className="text-xs text-gray-500 pt-2 border-t">
          Pricing not yet defined for this module
        </p>
      )}
    </Card>
  );
};

// ============================================================================
// Create Tenant Page
// ============================================================================

const isTerminalProvisioningStatus = (status: TenantProvisioningState): boolean =>
  status === TenantProvisioningState.SUCCEEDED || status === TenantProvisioningState.FAILED;

const CreateTenantPage: React.FC = () => {
  const navigate = useNavigate();

  // State
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<TenantFormData>(initialFormData);
  const [modulePricings, setModulePricings] = useState<ModulePricingWithModule[]>([]);
  const [priceCalculation, setPriceCalculation] = useState<PricingCalculation | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [calculatingPrice, setCalculatingPrice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [provisioningOperation, setProvisioningOperation] =
    useState<CreateTenantAcceptedResponse | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const quoteRequestSeq = useRef(0);
  const pollFailureCount = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const idempotencyStorageKeyRef = useRef<string | null>(null);

  const steps = [
    { label: 'Basic Info', description: 'Company details' },
    { label: 'Contact', description: 'Admin details' },
    { label: 'Modules & Pricing', description: 'Module selection' },
    { label: 'Confirmation', description: 'Final review' },
  ];

  // Load module pricings
  useEffect(() => {
    const loadData = async () => {
      try {
        // Get module pricings with module details
        const pricings = await billingApi.getModulePricingWithModules();
        const safePricings = Array.isArray(pricings) ? pricings : [];
        setModulePricings(safePricings);

        // Initialize module configs from pricings with includedQuantity as defaults
        const configs: ModuleConfig[] = safePricings.map((p) => {
          // Extract includedQuantity from pricing metrics as default values
          const defaultQuantities: ModuleQuantities = {
            users: 1,
            farms: 1,
            ponds: 0,
            sensors: 0,
            devices: 0,
            storageGb: 1,
            apiCalls: 0,
            alerts: 0,
            reports: 0,
            integrations: 0,
          };

          // Parse pricingMetrics if it's a string (JSONB from API sometimes comes as string)
          let metrics = p.pricingMetrics;
          if (typeof metrics === 'string') {
            try {
              metrics = JSON.parse(metrics);
            } catch {
              // metrics remains as-is if parsing fails
            }
          }

          // Set defaults from includedQuantity in pricing metrics (BUG-020: typed instead of any)
          if (metrics && Array.isArray(metrics)) {
            (metrics as Array<{ type: string; includedQuantity?: number; price?: number }>).forEach(
              (metric) => {
                const field = getQuantityField(metric.type);
                if (field && metric.includedQuantity && metric.includedQuantity > 0) {
                  defaultQuantities[field] = metric.includedQuantity;
                }
              },
            );
          }

          return {
            moduleId: p.moduleId,
            moduleCode: p.moduleCode,
            moduleName: p.moduleName || p.moduleCode,
            enabled: false,
            quantities: defaultQuantities,
          };
        });

        setFormData((prev) => ({ ...prev, moduleConfigs: configs }));
      } catch (err) {
        console.warn('Failed to load module pricings:', err);
        // Try to load basic modules as fallback
        try {
          const result = await modulesApi.list({ isActive: true, limit: 50 });
          const modules = Array.isArray(result?.data) ? result.data : [];
          const configs: ModuleConfig[] = modules.map((m: SystemModule) => ({
            moduleId: m.id,
            moduleCode: m.code,
            moduleName: m.name,
            enabled: false,
            quantities: {
              users: 1,
              farms: 1,
              storageGb: 1,
            },
          }));
          setFormData((prev) => ({ ...prev, moduleConfigs: configs }));
        } catch (fallbackErr) {
          console.warn('Failed to load modules:', fallbackErr);
        }
      } finally {
        setDataLoading(false);
      }
    };
    loadData();
  }, []);

  // NOTE: calculateLocalPrice removed — use the calculatedTotal useMemo below instead (PERF-006: eliminates duplicate computation)

  // Calculate price when modules/quantities change
  const calculatePrice = useCallback(async () => {
    const enabledModules = formData.moduleConfigs.filter((c) => c.enabled);
    if (enabledModules.length === 0) {
      quoteRequestSeq.current += 1;
      setPriceCalculation(null);
      return;
    }

    const requestId = quoteRequestSeq.current + 1;
    quoteRequestSeq.current = requestId;
    setCalculatingPrice(true);

    // Calculate locally first (most reliable) — use the same logic as calculatedTotal useMemo
    let localTotal = 0;
    enabledModules.forEach((config) => {
      const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
      if (pricing?.pricingMetrics && Array.isArray(pricing.pricingMetrics)) {
        pricing.pricingMetrics.forEach(
          (metric: { type: string; price?: number; includedQuantity?: number }) => {
            if (isBasePrice(metric.type)) {
              localTotal += metric.price || 0;
            } else {
              const field = getQuantityField(metric.type);
              if (field) {
                const qty = config.quantities[field] ?? 0;
                const included = metric.includedQuantity ?? 0;
                const billable = Math.max(0, qty - included);
                localTotal += billable * (metric.price || 0);
              }
            }
          },
        );
      }
    });

    // Set local calculation immediately
    const localCalculation: PricingCalculation = {
      subtotal: localTotal,
      tierDiscount: 0,
      discount: { amount: 0, percent: 0 },
      tax: 0,
      taxRate: 0,
      total: localTotal,
      monthlyTotal: localTotal,
      annualTotal: localTotal * 12,
      billingCycle: BillingCycle.MONTHLY,
      billingCycleMultiplier: 1,
      currency: 'USD',
      tier: PlanTier.STARTER,
      calculatedAt: new Date().toISOString(),
      modules: [],
    };

    setPriceCalculation(localCalculation);

    // Optionally try API for more accurate calculation (with discounts etc.)
    try {
      const request: QuoteRequest = {
        modules: enabledModules.map((c) => ({
          moduleId: c.moduleId,
          moduleCode: c.moduleCode,
          moduleName: c.moduleName,
          quantities: c.quantities,
        })),
        tier: formData.pricingTier as PlanTier,
        billingCycle: BillingCycle.MONTHLY,
      };

      const calculation = await billingApi.calculatePricing(request);
      if (quoteRequestSeq.current !== requestId) {
        return;
      }

      // Only use API result if it has valid totals
      const apiTotal = calculation.monthlyTotal ?? calculation.total ?? calculation.subtotal;
      if (apiTotal !== undefined && apiTotal >= 0) {
        const normalizedCalculation = {
          ...calculation,
          monthlyTotal: apiTotal,
          total: apiTotal,
        };
        setPriceCalculation(normalizedCalculation);
      }
    } catch (err) {
      // API failed, local calculation already set - that's fine
      console.debug('API pricing calculation not available, using local calculation');
    } finally {
      if (quoteRequestSeq.current === requestId) {
        setCalculatingPrice(false);
      }
    }
  }, [formData.moduleConfigs, formData.pricingTier, modulePricings]);

  // Debounced price calculation
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentStep === 2) {
        calculatePrice();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [calculatePrice, currentStep]);

  // Auto-generate slug from name
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    setFormData((prev) => ({ ...prev, name, slug }));
  }, []);

  // Handlers
  const updateFormData = useCallback(
    <K extends keyof TenantFormData>(key: K, value: TenantFormData[K]) => {
      setFormData((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const updateContactField = useCallback(
    (field: keyof TenantFormData['primaryContact'], value: string) => {
      setFormData((prev) => ({
        ...prev,
        primaryContact: { ...prev.primaryContact, [field]: value },
      }));
    },
    [],
  );

  const toggleModule = useCallback((moduleId: string) => {
    setFormData((prev) => ({
      ...prev,
      moduleConfigs: prev.moduleConfigs.map((c) =>
        c.moduleId === moduleId ? { ...c, enabled: !c.enabled } : c,
      ),
    }));
  }, []);

  const updateModuleQuantity = useCallback(
    (moduleId: string, field: keyof ModuleQuantities, value: number) => {
      setFormData((prev) => ({
        ...prev,
        moduleConfigs: prev.moduleConfigs.map((c) =>
          c.moduleId === moduleId ? { ...c, quantities: { ...c.quantities, [field]: value } } : c,
        ),
      }));
    },
    [],
  );

  // Validate slug format (BUG-009)
  const validateSlug = (slug: string): string | null => {
    if (slug.length < 3) return 'Slug must be at least 3 characters';
    if (slug.length > 63) return 'Slug must be at most 63 characters (hostname limit)';
    if (slug.startsWith('-') || slug.endsWith('-')) return 'Slug cannot start or end with a hyphen';
    if (/--/.test(slug)) return 'Slug cannot contain consecutive hyphens';
    if (!/^[a-z0-9-]+$/.test(slug))
      return 'Slug may only contain lowercase letters, numbers, and hyphens';
    return null;
  };

  const validateDomain = (domain: string): string | null => {
    const value = domain.trim().toLowerCase();
    if (!value) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) {
      return 'Domain must be a valid hostname';
    }
    return null;
  };

  const validateCountry = (country: string): string | null => {
    const value = country.trim().toUpperCase();
    if (!value) return null;
    if (!/^[A-Z]{2}$/.test(value)) return 'Country must be a 2-letter ISO code';
    return null;
  };

  const validateStep = (step: number): boolean => {
    switch (step) {
      case 0: {
        const slugError = validateSlug(formData.slug.trim());
        const domainError = validateDomain(formData.domain);
        const countryError = validateCountry(formData.country);
        return (
          formData.name.trim().length >= 2 &&
          formData.sustainedIngressMessagesPerSecond > 0 &&
          formData.sustainedMetricRowsPerMinute > 0 &&
          !slugError &&
          !domainError &&
          !countryError
        );
      }
      case 1:
        return (
          formData.primaryContact.name.trim().length >= 2 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.primaryContact.email)
        );
      case 2:
        return formData.moduleConfigs.some((c) => c.enabled);
      case 3:
        return true;
      default:
        return false;
    }
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      setCurrentStep((prev) => Math.min(prev + 1, steps.length - 1));
      setError(null);
    } else {
      if (currentStep === 2) {
        setError('Please select at least one module');
      } else if (currentStep === 0) {
        const slugError = validateSlug(formData.slug.trim());
        const domainError = validateDomain(formData.domain);
        const countryError = validateCountry(formData.country);
        setError(slugError || domainError || countryError || 'Please fill in all required fields');
      } else {
        setError('Please fill in all required fields');
      }
    }
  };

  const handlePrevious = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
    setError(null);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    try {
      // Get enabled modules for creation
      const enabledModulesForCreation = formData.moduleConfigs.filter((c) => c.enabled);

      // Create tenant with modules in a single request
      // Backend will handle module assignment, pricing calculation, and subscription creation
      const createData: CreateTenantDto = {
        name: formData.name,
        slug: formData.slug || undefined,
        description: formData.description || undefined,
        // FREE is a first-class tier now (Billing Revival Faz B) — pass the real
        // selection through instead of the old free→STARTER coercion, so the
        // backend provisions a genuine plan_tier='free' subscription.
        tier: formData.pricingTier as TenantTier,
        domain: formData.domain.trim().toLowerCase() || undefined,
        country: formData.country.trim().toUpperCase() || undefined,
        region: formData.region.trim() || undefined,
        sustainedIngressMessagesPerSecond: formData.sustainedIngressMessagesPerSecond,
        sustainedMetricRowsPerMinute: formData.sustainedMetricRowsPerMinute,
        primaryContact: {
          name: formData.primaryContact.name,
          email: formData.primaryContact.email,
          phone: formData.primaryContact.phone || undefined,
          role: 'Admin', // Required field
        },
        billingEmail: formData.billingEmail || formData.primaryContact.email,
        // FREE is permanent, never a trial — omit trialDays so the subscription
        // is created `active`, not `trial`.
        trialDays:
          formData.pricingTier === 'free'
            ? undefined
            : formData.trialDays > 0
              ? formData.trialDays
              : undefined,
        maxStorage: formData.maxStorage !== -1 ? formData.maxStorage : undefined,
        // NEW: Include moduleIds for backend to assign during creation
        moduleIds: enabledModulesForCreation.map((m) => m.moduleId),
        // NEW: Include module quantities for pricing calculation
        moduleQuantities: enabledModulesForCreation.map((m) => ({
          moduleId: m.moduleId,
          users: m.quantities.users,
          farms: m.quantities.farms,
          ponds: m.quantities.ponds,
          sensors: m.quantities.sensors,
          devices: m.quantities.devices,
          storageGb: m.quantities.storageGb,
          apiCalls: m.quantities.apiCalls,
          alerts: m.quantities.alerts,
          reports: m.quantities.reports,
          integrations: m.quantities.integrations,
        })),
        // NEW: Billing cycle
        billingCycle: BillingCycle.MONTHLY,
      };

      const idempotency = getTenantCreateIdempotency(createData);
      idempotencyStorageKeyRef.current = idempotency.storageKey ?? null;
      const operation = await tenantsApi.create(createData, idempotency.key);
      setProvisioningOperation(operation);

      if (operation.status === TenantProvisioningState.SUCCEEDED) {
        if (idempotency.storageKey) {
          window.sessionStorage.removeItem(idempotency.storageKey);
        }
        setSuccess(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!provisioningOperation || success) return;

    if (provisioningOperation.status === TenantProvisioningState.SUCCEEDED) {
      if (idempotencyStorageKeyRef.current && typeof window !== 'undefined') {
        window.sessionStorage.removeItem(idempotencyStorageKeyRef.current);
        idempotencyStorageKeyRef.current = null;
      }
      setSuccess(true);
      return;
    }

    if (provisioningOperation.status === TenantProvisioningState.FAILED) {
      setError('Tenant provisioning failed');
      return;
    }

    if (
      !isTerminalProvisioningStatus(provisioningOperation.status) &&
      (!Number.isFinite(provisioningOperation.retryAfterMs) ||
        provisioningOperation.retryAfterMs <= 0)
    ) {
      setError(
        'Tenant provisioning status contract error: retryAfterMs must be positive while operation is running',
      );
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    pollAbortRef.current?.abort();
    pollAbortRef.current = controller;
    const retryAfterMs = provisioningOperation.retryAfterMs;
    const pollDelay = Math.min(30_000, retryAfterMs * 2 ** pollFailureCount.current);
    const timer = window.setTimeout(async () => {
      try {
        const latest = await tenantsApi.getProvisioningOperationByStatusUrl(
          provisioningOperation.statusUrl,
          { signal: controller.signal },
        );
        if (!cancelled) {
          pollFailureCount.current = 0;
          setProvisioningOperation(latest);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (!cancelled) {
          pollFailureCount.current += 1;
          setError(err instanceof Error ? err.message : 'Failed to refresh provisioning status');
          setPollNonce((value) => value + 1);
        }
      }
    }, pollDelay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
      if (pollAbortRef.current === controller) {
        pollAbortRef.current = null;
      }
    };
  }, [provisioningOperation, success, pollNonce]);

  const handleRetryProvisioning = async () => {
    if (!provisioningOperation) return;
    setLoading(true);
    setError(null);
    try {
      const retried = await tenantsApi.retryProvisioningOperation(provisioningOperation.statusUrl);
      setProvisioningOperation(retried);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry provisioning');
    } finally {
      setLoading(false);
    }
  };

  // Enabled modules count and total
  const enabledModules = useMemo(
    () => formData.moduleConfigs.filter((c) => c.enabled),
    [formData.moduleConfigs],
  );

  // Calculate total price directly from enabled modules (reliable, no API dependency)
  const calculatedTotal = useMemo(() => {
    // FREE is a permanent $0 tier (Billing Revival Faz B): the platform fee and
    // every module charge are waived, so the wizard must never show a paid amount.
    // Short-circuit before summing module metrics.
    if (formData.pricingTier === 'free') return 0;

    let total = 0;

    enabledModules.forEach((config) => {
      const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);

      if (pricing?.pricingMetrics && Array.isArray(pricing.pricingMetrics)) {
        pricing.pricingMetrics.forEach((metric) => {
          if (isBasePrice(metric.type)) {
            total += metric.price || 0;
          } else {
            const field = getQuantityField(metric.type);
            if (field) {
              const includedQty = metric.includedQuantity ?? 0;
              const minQty = Math.max(metric.minQuantity ?? 0, 0);
              const qty = Math.max(config.quantities[field] ?? minQty, minQty);
              const billableQty = Math.max(0, qty - includedQty);
              total += billableQty * (metric.price || 0);
            }
          }
        });
      }
    });
    return total;
  }, [enabledModules, modulePricings, formData.pricingTier]);

  if (provisioningOperation && !success) {
    const isFailed = provisioningOperation.status === TenantProvisioningState.FAILED;
    const canRetry = provisioningOperation.availableActions?.includes('retryProvisioning') === true;

    return (
      <div className="max-w-2xl mx-auto">
        <Card className="p-8">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Tenant Provisioning</h2>
              <p className="text-gray-600 mt-1">{formData.name} is being provisioned.</p>
            </div>
            <Badge variant={isFailed ? 'error' : 'warning'}>{provisioningOperation.status}</Badge>
          </div>

          {error && (
            <Alert type={isFailed ? 'error' : 'warning'} className="mb-6">
              {error}
            </Alert>
          )}

          <div className="space-y-3 mb-6">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Status URL</span>
              <span className="font-mono text-gray-700">{provisioningOperation.statusUrl}</span>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => navigate('/admin/tenants')}>
              Tenant List
            </Button>
            {canRetry ? (
              <Button onClick={handleRetryProvisioning} loading={loading}>
                Retry
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={async () => {
                  setError(null);
                  try {
                    const latest = await tenantsApi.getProvisioningOperationByStatusUrl(
                      provisioningOperation.statusUrl,
                    );
                    pollFailureCount.current = 0;
                    setProvisioningOperation(latest);
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : 'Failed to refresh provisioning status',
                    );
                  }
                }}
              >
                Refresh
              </Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // Success view
  if (success) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card className="p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-green-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            Tenant Provisioned Successfully!
          </h2>
          <p className="text-gray-600 mb-4">
            Tenant <strong>{formData.name}</strong> has been created and provisioned.
          </p>
          {enabledModules.length > 0 && (
            <div className="bg-indigo-50 rounded-lg p-4 mb-6">
              <p className="text-sm text-gray-600">Monthly Price</p>
              <p className="text-3xl font-bold text-indigo-600">
                ${calculatedTotal.toFixed(2)}
                <span className="text-sm font-normal text-gray-500">/mo</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">{enabledModules.length} modules active</p>
            </div>
          )}
          {formData.primaryContact.email && (
            <p className="text-sm text-gray-500 mb-6">
              Primary contact: <strong>{formData.primaryContact.email}</strong>
            </p>
          )}
          <div className="flex justify-center gap-4">
            <Button variant="outline" onClick={() => navigate('/admin/tenants')}>
              Tenant List
            </Button>
            <Button onClick={() => window.location.reload()}>Create Another</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Create New Tenant</h1>
          <p className="text-gray-500 mt-1">Create a custom package with module-based pricing</p>
        </div>
        <Button variant="ghost" onClick={() => navigate('/admin/tenants')}>
          Cancel
        </Button>
      </div>

      {/* Step Indicator */}
      <StepIndicator steps={steps} currentStep={currentStep} />

      {/* Error */}
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Step Content */}
      <div className="flex gap-6">
        {/* Main Content */}
        <Card className={`flex-1 p-6 ${currentStep === 2 ? 'max-w-3xl' : ''}`}>
          {/* Step 1: Basic Info */}
          {currentStep === 0 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold border-b pb-2">Basic Information</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Company Name *"
                  value={formData.name}
                  onChange={handleNameChange}
                  placeholder="Example: Ocean Farm Inc."
                />
                <Input
                  label="Slug (URL)"
                  value={formData.slug}
                  onChange={(e) =>
                    updateFormData('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }
                  placeholder="ocean-farm"
                  helperText="Short name to be used in URLs"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Sustained MQTT Messages / Second *"
                  type="number"
                  value={String(formData.sustainedIngressMessagesPerSecond)}
                  onChange={(event) =>
                    updateFormData(
                      'sustainedIngressMessagesPerSecond',
                      Number.parseFloat(event.target.value),
                    )
                  }
                  min={1}
                  helperText="Capacity dimension M reserved before provisioning"
                />
                <Input
                  label="Sustained Metric Rows / Minute *"
                  type="number"
                  value={String(formData.sustainedMetricRowsPerMinute)}
                  onChange={(event) =>
                    updateFormData(
                      'sustainedMetricRowsPerMinute',
                      Number.parseFloat(event.target.value),
                    )
                  }
                  min={1}
                  helperText="Capacity dimension R; measured separately from MQTT ingress"
                />
              </div>

              <Input
                label="Description"
                value={formData.description}
                onChange={(e) => updateFormData('description', e.target.value)}
                placeholder="Brief description about the company..."
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Domain"
                  value={formData.domain}
                  onChange={(e) => updateFormData('domain', e.target.value)}
                  placeholder="ocean-farm.aquaculture.io"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Country"
                    value={formData.country}
                    onChange={(e) => updateFormData('country', e.target.value.toUpperCase())}
                    placeholder="TR"
                  />
                  <Input
                    label="Region"
                    value={formData.region}
                    onChange={(e) => updateFormData('region', e.target.value)}
                    placeholder="Ege"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Trial Period (Days)"
                  type="number"
                  value={String(formData.trialDays)}
                  onChange={(e) => updateFormData('trialDays', parseInt(e.target.value) || 0)}
                  min={0}
                  max={90}
                  helperText="0 = No trial period"
                />
                <Input
                  label="Storage Limit (GB)"
                  type="number"
                  value={String(formData.maxStorage)}
                  onChange={(e) => updateFormData('maxStorage', parseInt(e.target.value) || -1)}
                  min={-1}
                  helperText="-1 = Unlimited storage"
                />
              </div>
            </div>
          )}

          {/* Step 2: Contact Info */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold border-b pb-2">Admin Information</h3>
              <p className="text-sm text-gray-600">
                This information will be used to create the tenant's first admin user.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Full Name *"
                  value={formData.primaryContact.name}
                  onChange={(e) => updateContactField('name', e.target.value)}
                  placeholder="John Doe"
                />
                <Input
                  label="E-posta *"
                  type="email"
                  value={formData.primaryContact.email}
                  onChange={(e) => updateContactField('email', e.target.value)}
                  placeholder="admin@company.com"
                  helperText="Invitation will be sent to this address"
                />
              </div>

              <Input
                label="Phone"
                value={formData.primaryContact.phone}
                onChange={(e) => updateContactField('phone', e.target.value)}
                placeholder="+90 555 123 4567"
              />

              <div className="border-t pt-4 mt-4">
                <h4 className="text-md font-medium text-gray-700 mb-3">Billing Information</h4>
                <Input
                  label="Billing Email"
                  type="email"
                  value={formData.billingEmail}
                  onChange={(e) => updateFormData('billingEmail', e.target.value)}
                  placeholder="billing@company.com"
                  helperText="If left empty, admin email will be used"
                />
              </div>
            </div>
          )}

          {/* Step 3: Modules & Pricing */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b pb-2">
                <div>
                  <h3 className="text-lg font-semibold">Module Selection & Pricing</h3>
                  <p className="text-sm text-gray-500">
                    Define the required metrics for each module
                  </p>
                </div>
              </div>

              {/* Plan tier selector (Billing Revival Faz B). FREE = permanent $0. */}
              <div className="p-4 bg-white rounded-lg border">
                <RadioGroup
                  label="Plan Tier"
                  name="pricingTier"
                  vertical={false}
                  options={TIER_OPTIONS}
                  value={formData.pricingTier}
                  onChange={(value) => updateFormData('pricingTier', value as PricingTier)}
                />
                {formData.pricingTier === 'free' && (
                  <Alert type="info" className="mt-4">
                    <span className="font-medium">Free plan — permanent $0.</span> No platform fee
                    and no module charges. Included allowances: up to {FREE_TIER_LIMITS.maxUsers}{' '}
                    users, {FREE_TIER_LIMITS.maxFarms} farm, {FREE_TIER_LIMITS.maxPonds} ponds,{' '}
                    {FREE_TIER_LIMITS.maxSensors} sensors, {FREE_TIER_LIMITS.dataRetentionDays}-day
                    data retention. The tenant can be upgraded to a paid plan later.
                  </Alert>
                )}
              </div>

              {dataLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
                </div>
              ) : formData.moduleConfigs.length > 0 ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {formData.moduleConfigs.map((config) => {
                    const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
                    return (
                      <ModuleConfigCard
                        key={config.moduleId}
                        config={config}
                        pricing={pricing}
                        onToggle={() => toggleModule(config.moduleId)}
                        onQuantityChange={(field, value) =>
                          updateModuleQuantity(config.moduleId, field, value)
                        }
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500">No modules found</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Please define modules in Billing &gt; Module Pricing page first
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Review */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold border-b pb-2">Confirmation</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Basic Info Summary */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-gray-700 mb-3">Company Information</h4>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Ad:</dt>
                      <dd className="font-medium">{formData.name}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Slug:</dt>
                      <dd className="font-mono">{formData.slug}</dd>
                    </div>
                    {formData.trialDays > 0 && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Trial:</dt>
                        <dd>{formData.trialDays} days</dd>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Storage:</dt>
                      <dd>
                        {formData.maxStorage === -1 ? 'Unlimited' : `${formData.maxStorage} GB`}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Telemetry M:</dt>
                      <dd>{formData.sustainedIngressMessagesPerSecond} msg/s</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Telemetry R:</dt>
                      <dd>{formData.sustainedMetricRowsPerMinute} rows/min</dd>
                    </div>
                    {formData.country && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Location:</dt>
                        <dd>
                          {formData.country} {formData.region && `/ ${formData.region}`}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>

                {/* Contact Summary */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-gray-700 mb-3">Admin Information</h4>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Ad:</dt>
                      <dd className="font-medium">{formData.primaryContact.name}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-gray-500">E-posta:</dt>
                      <dd>{formData.primaryContact.email}</dd>
                    </div>
                    {formData.primaryContact.phone && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Telefon:</dt>
                        <dd>{formData.primaryContact.phone}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              </div>

              {/* Modules Summary */}
              <div className="p-4 bg-gray-50 rounded-lg">
                <h4 className="font-medium text-gray-700 mb-3">Selected Modules</h4>
                <div className="space-y-3">
                  {enabledModules.map((config) => {
                    const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
                    const hasQuantities = Object.values(config.quantities).some((v) => v > 0);
                    return (
                      <div key={config.moduleId} className="p-3 bg-white rounded border">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{config.moduleName}</span>
                          <Badge variant="success" size="sm">
                            Active
                          </Badge>
                        </div>
                        {hasQuantities && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {config.quantities.users && config.quantities.users > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.users} Users
                              </span>
                            )}
                            {config.quantities.farms && config.quantities.farms > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.farms} Farms
                              </span>
                            )}
                            {config.quantities.sensors && config.quantities.sensors > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.sensors} Sensors
                              </span>
                            )}
                            {config.quantities.storageGb && config.quantities.storageGb > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.storageGb} GB
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <Alert type="info">
                Tenant provisioning will create the workspace, admin access, module assignments, and
                billing subscription for <strong>{formData.primaryContact.email}</strong>.
              </Alert>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between mt-8 pt-6 border-t">
            <Button variant="outline" onClick={handlePrevious} disabled={currentStep === 0}>
              Back
            </Button>

            {currentStep < steps.length - 1 ? (
              <Button onClick={handleNext} disabled={!validateStep(currentStep)}>
                Continue
              </Button>
            ) : (
              <Button onClick={handleSubmit} loading={loading}>
                Create Tenant
              </Button>
            )}
          </div>
        </Card>

        {/* Pricing Summary Sidebar - Only on Step 3 */}
        {currentStep === 2 && (
          <div className="w-80 flex-shrink-0">
            <Card className="p-5 sticky top-4 bg-gradient-to-br from-indigo-50 to-purple-50 border-indigo-200">
              <h4 className="font-semibold text-gray-900 mb-4">Price Summary</h4>

              {enabledModules.length === 0 ? (
                <p className="text-sm text-gray-500">Select modules...</p>
              ) : (
                <div className="space-y-4">
                  {/* Selected Modules */}
                  <div className="space-y-2">
                    {enabledModules.map((config) => (
                      <div
                        key={config.moduleId}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-gray-600 truncate">{config.moduleName}</span>
                        <Badge variant="info" size="sm">
                          Active
                        </Badge>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-indigo-200 pt-4">
                    {/* Always show calculated total - no loading state needed */}
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-500">Subtotal</span>
                      <span>${calculatedTotal.toFixed(2)}</span>
                    </div>
                    {priceCalculation && (priceCalculation.tierDiscount || 0) > 0 && (
                      <div className="flex justify-between text-sm text-green-600 mb-1">
                        <span>Tier Discount</span>
                        <span>-${priceCalculation.tierDiscount.toFixed(2)}</span>
                      </div>
                    )}
                    {priceCalculation?.discount && priceCalculation.discount.amount > 0 && (
                      <div className="flex justify-between text-sm text-green-600 mb-1">
                        <span>{priceCalculation.discount.description || 'Discount'}</span>
                        <span>-${priceCalculation.discount.amount.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-baseline pt-3 border-t border-indigo-200 mt-3">
                      <span className="font-semibold text-gray-900">Monthly Total</span>
                      <div className="text-right">
                        <span className="text-2xl font-bold text-indigo-600">
                          ${calculatedTotal.toFixed(2)}
                        </span>
                        <span className="text-sm text-gray-500">/mo</span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-gray-500 pt-2">* Prices are shown excluding taxes</p>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
};

export default CreateTenantPage;
