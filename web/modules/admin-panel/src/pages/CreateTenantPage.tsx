/**
 * Create Tenant Page - Modular Pricing Edition
 *
 * Multi-step tenant creation wizard with:
 * - Module selection with metric-based pricing
 * - Real-time price calculation
 * - Custom pricing per tenant (no fixed plans)
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Badge,
  Input,
  Select,
  Alert,
} from '@aquaculture/shared-ui';
import {
  tenantsApi,
  modulesApi,
  billingApi,
  PricingMetricType,
  TenantTier,
  PlanTier,
  BillingCycle,
  type SystemModule,
  type CreateTenantDto,
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
}

const initialFormData: TenantFormData = {
  name: '',
  slug: '',
  description: '',
  domain: '',
  country: '',
  region: '',
  primaryContact: {
    name: '',
    email: '',
    phone: '',
  },
  billingEmail: '',
  moduleConfigs: [],
  pricingTier: 'starter',
  trialDays: 14,
};

// Helper to check if metric is BASE_PRICE (handles both string and enum)
const isBasePrice = (metricType: string | PricingMetricType): boolean => {
  return metricType === 'BASE_PRICE' || metricType === PricingMetricType.BASE_PRICE;
};

// Helper to get metric label (handles both string and enum keys)
const getMetricLabel = (metricType: string | PricingMetricType): string => {
  const labels: Record<string, string> = {
    'BASE_PRICE': 'Temel Ucret',
    'PER_USER': 'Kullanici Basina',
    'PER_FARM': 'Ciftlik Basina',
    'PER_POND': 'Havuz Basina',
    'PER_SENSOR': 'Sensor Basina',
    'PER_DEVICE': 'Cihaz Basina',
    'PER_GB_STORAGE': 'GB Depolama',
    'PER_API_CALL': 'API Cagrisi',
    'PER_ALERT': 'Alarm Basina',
    'PER_REPORT': 'Rapor Basina',
    'PER_SMS': 'SMS Basina',
    'PER_EMAIL': 'E-posta Basina',
    'PER_INTEGRATION': 'Entegrasyon Basina',
  };
  return labels[metricType] || metricType;
};

// Helper to get quantity field for metric type
const getQuantityField = (metricType: string | PricingMetricType): keyof ModuleQuantities | null => {
  const mapping: Record<string, keyof ModuleQuantities | null> = {
    'BASE_PRICE': null,
    'PER_USER': 'users',
    'PER_FARM': 'farms',
    'PER_POND': 'ponds',
    'PER_SENSOR': 'sensors',
    'PER_DEVICE': 'devices',
    'PER_GB_STORAGE': 'storageGb',
    'PER_API_CALL': 'apiCalls',
    'PER_ALERT': 'alerts',
    'PER_REPORT': 'reports',
    'PER_SMS': null,
    'PER_EMAIL': null,
    'PER_INTEGRATION': 'integrations',
  };
  return mapping[metricType] || null;
};

// Metric labels for display
const metricLabels: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: 'Temel Ucret',
  [PricingMetricType.PER_USER]: 'Kullanici Basina',
  [PricingMetricType.PER_FARM]: 'Ciftlik Basina',
  [PricingMetricType.PER_POND]: 'Havuz Basina',
  [PricingMetricType.PER_SENSOR]: 'Sensor Basina',
  [PricingMetricType.PER_DEVICE]: 'Cihaz Basina',
  [PricingMetricType.PER_GB_STORAGE]: 'GB Depolama',
  [PricingMetricType.PER_API_CALL]: 'API Cagrisi',
  [PricingMetricType.PER_ALERT]: 'Alarm Basina',
  [PricingMetricType.PER_REPORT]: 'Rapor Basina',
  [PricingMetricType.PER_SMS]: 'SMS Basina',
  [PricingMetricType.PER_EMAIL]: 'E-posta Basina',
  [PricingMetricType.PER_INTEGRATION]: 'Entegrasyon Basina',
};

// Map metric type to quantity field
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
  [PricingMetricType.PER_SMS]: null, // SMS için ayrı field yok
  [PricingMetricType.PER_EMAIL]: null, // Email için ayrı field yok
  [PricingMetricType.PER_INTEGRATION]: 'integrations',
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
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                index + 1
              )}
            </div>
            <div className="mt-2 text-center">
              <p className={`text-sm font-medium ${index <= currentStep ? 'text-gray-900' : 'text-gray-500'}`}>
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
    <Card className={`p-4 transition-all ${config.enabled ? 'ring-2 ring-indigo-500 bg-indigo-50/50' : 'bg-white'}`}>
      {/* Module Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onToggle}
            className={`mt-1 w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
              config.enabled
                ? 'bg-indigo-600 border-indigo-600'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            {config.enabled && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <div>
            <h4 className="font-semibold text-gray-900">{config.moduleName}</h4>
            <p className="text-xs text-gray-500">{config.moduleCode}</p>
          </div>
        </div>
        {config.enabled && (
          <Badge variant="success" size="sm">Aktif</Badge>
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
                    ${(metric.price || 0).toFixed(2)}/ay
                  </span>
                </div>
              );
            }

            if (!quantityField) return null;

            const includedQty = metric.includedQuantity || 0;
            const minQty = Math.max(includedQty, metric.minQuantity || 1);
            const currentValue = Math.max(config.quantities[quantityField] || minQty, minQty);
            const unitPrice = metric.price || 0;
            const extraQty = Math.max(0, currentValue - includedQty);

            return (
              <div key={metric.type} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-gray-600">
                    {getMetricLabel(metric.type)}
                    {includedQty > 0 && (
                      <span className="text-xs text-green-600 ml-1">({includedQty} dahil)</span>
                    )}
                  </label>
                  <span className="text-xs text-gray-500">${unitPrice.toFixed(2)}/adet</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={minQty}
                    max={metric.maxQuantity || 9999}
                    value={currentValue}
                    onChange={(e) => {
                      const newValue = parseInt(e.target.value) || minQty;
                      onQuantityChange(quantityField, Math.max(newValue, minQty));
                    }}
                    className="w-24 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <span className="text-sm text-gray-500">adet</span>
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
        <p className="text-xs text-gray-400 pt-2 border-t">
          Bu modul icin fiyatlandirma henuz tanimlanmamis
        </p>
      )}
    </Card>
  );
};

// ============================================================================
// Create Tenant Page
// ============================================================================

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
  const [createdTenantId, setCreatedTenantId] = useState<string | null>(null);

  const steps = [
    { label: 'Temel Bilgiler', description: 'Sirket bilgileri' },
    { label: 'Iletisim', description: 'Yonetici bilgileri' },
    { label: 'Moduller & Fiyat', description: 'Modul secimi' },
    { label: 'Onay', description: 'Son kontrol' },
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
        console.log('=== LOADING MODULE PRICINGS ===');
        console.log('Raw pricings:', safePricings);

        const configs: ModuleConfig[] = safePricings.map((p) => {
          console.log(`Processing module: ${p.moduleCode}`);
          console.log('  pricingMetrics:', p.pricingMetrics);
          console.log('  pricingMetrics type:', typeof p.pricingMetrics);
          console.log('  isArray:', Array.isArray(p.pricingMetrics));

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
              console.log('  Parsed metrics from string:', metrics);
            } catch (e) {
              console.error('  Failed to parse metrics:', e);
            }
          }

          // Set defaults from includedQuantity in pricing metrics
          if (metrics && Array.isArray(metrics)) {
            metrics.forEach((metric: any) => {
              const field = getQuantityField(metric.type);
              console.log(`    Metric: ${metric.type}, field: ${field}, includedQty: ${metric.includedQuantity}`);
              if (field && metric.includedQuantity && metric.includedQuantity > 0) {
                defaultQuantities[field] = metric.includedQuantity;
                console.log(`    -> Set ${field} = ${metric.includedQuantity}`);
              }
            });
          }

          console.log('  Final quantities:', defaultQuantities);

          return {
            moduleId: p.moduleId,
            moduleCode: p.moduleCode,
            moduleName: p.moduleName || p.moduleCode,
            enabled: false,
            quantities: defaultQuantities,
          };
        });

        console.log('=== FINAL CONFIGS ===', configs);

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

  // Calculate price locally from module pricings
  const calculateLocalPrice = useCallback((enabledConfigs: ModuleConfig[]): number => {
    let total = 0;
    enabledConfigs.forEach((config) => {
      const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
      if (pricing?.pricingMetrics && Array.isArray(pricing.pricingMetrics)) {
        pricing.pricingMetrics.forEach((metric) => {
          if (isBasePrice(metric.type)) {
            total += metric.price || 0;
          } else {
            const field = getQuantityField(metric.type);
            if (field) {
              const qty = config.quantities[field] || 0;
              const included = metric.includedQuantity || 0;
              const billable = Math.max(0, qty - included);
              total += billable * (metric.price || 0);
            }
          }
        });
      }
    });
    return total;
  }, [modulePricings]);

  // Calculate price when modules/quantities change
  const calculatePrice = useCallback(async () => {
    const enabledModules = formData.moduleConfigs.filter((c) => c.enabled);
    if (enabledModules.length === 0) {
      setPriceCalculation(null);
      return;
    }

    setCalculatingPrice(true);

    // Always calculate locally first (most reliable)
    const localTotal = calculateLocalPrice(enabledModules);

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

      // Only use API result if it has valid totals
      const apiTotal = calculation.monthlyTotal || calculation.total || calculation.subtotal;
      if (apiTotal && apiTotal > 0) {
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
      setCalculatingPrice(false);
    }
  }, [formData.moduleConfigs, formData.pricingTier, calculateLocalPrice]);

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
  const updateFormData = useCallback(<K extends keyof TenantFormData>(
    key: K,
    value: TenantFormData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateContactField = useCallback((field: keyof TenantFormData['primaryContact'], value: string) => {
    setFormData((prev) => ({
      ...prev,
      primaryContact: { ...prev.primaryContact, [field]: value },
    }));
  }, []);

  const toggleModule = useCallback((moduleId: string) => {
    setFormData((prev) => ({
      ...prev,
      moduleConfigs: prev.moduleConfigs.map((c) =>
        c.moduleId === moduleId ? { ...c, enabled: !c.enabled } : c
      ),
    }));
  }, []);

  const updateModuleQuantity = useCallback((moduleId: string, field: keyof ModuleQuantities, value: number) => {
    setFormData((prev) => ({
      ...prev,
      moduleConfigs: prev.moduleConfigs.map((c) =>
        c.moduleId === moduleId
          ? { ...c, quantities: { ...c.quantities, [field]: value } }
          : c
      ),
    }));
  }, []);

  const validateStep = (step: number): boolean => {
    switch (step) {
      case 0:
        return formData.name.trim().length >= 2 && formData.slug.trim().length >= 2;
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
        setError('En az bir modul secmelisiniz');
      } else {
        setError('Lutfen gerekli alanlari doldurun');
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
        tier: formData.pricingTier === 'free' ? TenantTier.STARTER : formData.pricingTier as TenantTier,
        domain: formData.domain || undefined,
        country: formData.country || undefined,
        region: formData.region || undefined,
        primaryContact: {
          name: formData.primaryContact.name,
          email: formData.primaryContact.email,
          phone: formData.primaryContact.phone || undefined,
          role: 'Admin', // Required field
        },
        billingEmail: formData.billingEmail || formData.primaryContact.email,
        trialDays: formData.trialDays > 0 ? formData.trialDays : undefined,
        // NEW: Include moduleIds for backend to assign during creation
        moduleIds: enabledModulesForCreation.map((m) => m.moduleId),
        // NEW: Include module quantities for pricing calculation
        moduleQuantities: enabledModulesForCreation.map((m) => ({
          moduleId: m.moduleId,
          users: m.quantities.users,
          farms: m.quantities.farms,
          ponds: m.quantities.ponds,
          sensors: m.quantities.sensors,
        })),
        // NEW: Billing cycle
        billingCycle: BillingCycle.MONTHLY,
      };

      const tenant = await tenantsApi.create(createData);
      setCreatedTenantId(tenant.id);

      // NOTE: Module assignment and subscription creation is now handled by backend
      // during tenant creation. The backend will:
      // 1. Create the tenant
      // 2. Assign selected modules with quantities
      // 3. Calculate pricing based on tier and quantities
      // 4. Create subscription with trial period if specified
      // 5. Send invitation email to the primary contact

      console.log('Tenant created successfully:', tenant.id);
      console.log('Modules assigned:', enabledModulesForCreation.map(m => m.moduleName).join(', '));

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tenant olusturulamadi');
    } finally {
      setLoading(false);
    }
  };

  // Enabled modules count and total
  const enabledModules = useMemo(
    () => formData.moduleConfigs.filter((c) => c.enabled),
    [formData.moduleConfigs]
  );

  // Calculate total price directly from enabled modules (reliable, no API dependency)
  const calculatedTotal = useMemo(() => {
    let total = 0;
    console.log('=== PRICE CALCULATION DEBUG ===');
    console.log('Enabled modules:', enabledModules.length);
    console.log('Module pricings:', modulePricings.length);

    enabledModules.forEach((config) => {
      const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
      console.log(`Module ${config.moduleName}:`, pricing ? 'found' : 'NOT FOUND');

      if (pricing?.pricingMetrics && Array.isArray(pricing.pricingMetrics)) {
        console.log(`  Metrics count: ${pricing.pricingMetrics.length}`);
        pricing.pricingMetrics.forEach((metric) => {
          console.log(`  Metric: ${metric.type}, price: ${metric.price}, isBase: ${isBasePrice(metric.type)}`);

          if (isBasePrice(metric.type)) {
            // Base price - always added
            total += metric.price || 0;
            console.log(`    Added base price: ${metric.price}, total now: ${total}`);
          } else {
            // Usage-based metric
            const field = getQuantityField(metric.type);
            console.log(`    Field for ${metric.type}: ${field}`);
            if (field) {
              const includedQty = metric.includedQuantity || 0;
              const minQty = Math.max(includedQty, 1);
              const qty = Math.max(config.quantities[field] || minQty, minQty);
              const billableQty = Math.max(0, qty - includedQty);
              const cost = billableQty * (metric.price || 0);
              total += cost;
              console.log(`    qty: ${qty}, included: ${includedQty}, billable: ${billableQty}, cost: ${cost}, total: ${total}`);
            }
          }
        });
      }
    });
    console.log('=== FINAL TOTAL:', total, '===');
    return total;
  }, [enabledModules, modulePricings]);

  // Success view
  if (success && createdTenantId) {
    return (
      <div className="max-w-2xl mx-auto">
        <Card className="p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Tenant Basariyla Olusturuldu!</h2>
          <p className="text-gray-600 mb-4">
            <strong>{formData.name}</strong> tenant'i olusturuldu.
          </p>
          {enabledModules.length > 0 && (
            <div className="bg-indigo-50 rounded-lg p-4 mb-6">
              <p className="text-sm text-gray-600">Aylik Fiyat</p>
              <p className="text-3xl font-bold text-indigo-600">
                ${calculatedTotal.toFixed(2)}
                <span className="text-sm font-normal text-gray-500">/ay</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">{enabledModules.length} modul aktif</p>
            </div>
          )}
          {formData.primaryContact.email && (
            <p className="text-sm text-gray-500 mb-6">
              Admin kullanicisi icin <strong>{formData.primaryContact.email}</strong> adresine davet e-postasi gonderildi.
            </p>
          )}
          <div className="flex justify-center gap-4">
            <Button variant="outline" onClick={() => navigate('/admin/tenants')}>
              Tenant Listesi
            </Button>
            <Button onClick={() => navigate(`/admin/tenants/${createdTenantId}`)}>
              Tenant Detayi
            </Button>
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
          <h1 className="text-2xl font-bold text-gray-900">Yeni Tenant Olustur</h1>
          <p className="text-gray-500 mt-1">Modul bazli fiyatlandirma ile ozel paket olusturun</p>
        </div>
        <Button variant="ghost" onClick={() => navigate('/admin/tenants')}>
          Iptal
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
              <h3 className="text-lg font-semibold border-b pb-2">Temel Bilgiler</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Sirket Adi *"
                  value={formData.name}
                  onChange={handleNameChange}
                  placeholder="Ornek: Deniz Ciftligi A.S."
                />
                <Input
                  label="Slug (URL)"
                  value={formData.slug}
                  onChange={(e) => updateFormData('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="deniz-ciftligi"
                  helperText="URL'de kullanilacak kisa ad"
                />
              </div>

              <Input
                label="Aciklama"
                value={formData.description}
                onChange={(e) => updateFormData('description', e.target.value)}
                placeholder="Sirket hakkinda kisa aciklama..."
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Domain"
                  value={formData.domain}
                  onChange={(e) => updateFormData('domain', e.target.value)}
                  placeholder="deniz-ciftligi.aquaculture.io"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Ulke"
                    value={formData.country}
                    onChange={(e) => updateFormData('country', e.target.value)}
                    placeholder="Turkiye"
                  />
                  <Input
                    label="Bolge"
                    value={formData.region}
                    onChange={(e) => updateFormData('region', e.target.value)}
                    placeholder="Ege"
                  />
                </div>
              </div>

              <Input
                label="Deneme Suresi (Gun)"
                type="number"
                value={String(formData.trialDays)}
                onChange={(e) => updateFormData('trialDays', parseInt(e.target.value) || 0)}
                min={0}
                max={90}
                helperText="0 = Deneme suresi yok"
              />
            </div>
          )}

          {/* Step 2: Contact Info */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold border-b pb-2">Yonetici Bilgileri</h3>
              <p className="text-sm text-gray-600">
                Bu bilgiler tenant'in ilk admin kullanicisini olusturmak icin kullanilacak.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Ad Soyad *"
                  value={formData.primaryContact.name}
                  onChange={(e) => updateContactField('name', e.target.value)}
                  placeholder="Ahmet Yilmaz"
                />
                <Input
                  label="E-posta *"
                  type="email"
                  value={formData.primaryContact.email}
                  onChange={(e) => updateContactField('email', e.target.value)}
                  placeholder="ahmet@sirket.com"
                  helperText="Davet bu adrese gonderilecek"
                />
              </div>

              <Input
                label="Telefon"
                value={formData.primaryContact.phone}
                onChange={(e) => updateContactField('phone', e.target.value)}
                placeholder="+90 555 123 4567"
              />

              <div className="border-t pt-4 mt-4">
                <h4 className="text-md font-medium text-gray-700 mb-3">Fatura Bilgileri</h4>
                <Input
                  label="Fatura E-posta"
                  type="email"
                  value={formData.billingEmail}
                  onChange={(e) => updateFormData('billingEmail', e.target.value)}
                  placeholder="muhasebe@sirket.com"
                  helperText="Bos birakilirsa yonetici e-postasi kullanilir"
                />
              </div>
            </div>
          )}

          {/* Step 3: Modules & Pricing */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b pb-2">
                <div>
                  <h3 className="text-lg font-semibold">Modul Secimi & Fiyatlandirma</h3>
                  <p className="text-sm text-gray-500">Her modul icin ihtiyac duyulan metrikleri belirleyin</p>
                </div>
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
                        onQuantityChange={(field, value) => updateModuleQuantity(config.moduleId, field, value)}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500">Modul bulunamadi</p>
                  <p className="text-sm text-gray-400 mt-1">
                    Oncesinde Billing &gt; Module Pricing sayfasindan modulleri tanimlayin
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Review */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <h3 className="text-lg font-semibold border-b pb-2">Onay</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Basic Info Summary */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-gray-700 mb-3">Sirket Bilgileri</h4>
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
                        <dt className="text-gray-500">Deneme:</dt>
                        <dd>{formData.trialDays} gun</dd>
                      </div>
                    )}
                    {formData.country && (
                      <div className="flex justify-between">
                        <dt className="text-gray-500">Konum:</dt>
                        <dd>{formData.country} {formData.region && `/ ${formData.region}`}</dd>
                      </div>
                    )}
                  </dl>
                </div>

                {/* Contact Summary */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-gray-700 mb-3">Yonetici Bilgileri</h4>
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
                <h4 className="font-medium text-gray-700 mb-3">Secili Moduller</h4>
                <div className="space-y-3">
                  {enabledModules.map((config) => {
                    const pricing = modulePricings.find((p) => p.moduleId === config.moduleId);
                    const hasQuantities = Object.values(config.quantities).some((v) => v > 0);
                    return (
                      <div key={config.moduleId} className="p-3 bg-white rounded border">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{config.moduleName}</span>
                          <Badge variant="success" size="sm">Aktif</Badge>
                        </div>
                        {hasQuantities && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {config.quantities.users && config.quantities.users > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.users} Kullanici
                              </span>
                            )}
                            {config.quantities.farms && config.quantities.farms > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.farms} Ciftlik
                              </span>
                            )}
                            {config.quantities.sensors && config.quantities.sensors > 0 && (
                              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                                {config.quantities.sensors} Sensor
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
                Tenant olusturuldugunda, <strong>{formData.primaryContact.email}</strong> adresine davet e-postasi gonderilecektir.
              </Alert>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between mt-8 pt-6 border-t">
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentStep === 0}
            >
              Geri
            </Button>

            {currentStep < steps.length - 1 ? (
              <Button onClick={handleNext} disabled={!validateStep(currentStep)}>
                Devam
              </Button>
            ) : (
              <Button onClick={handleSubmit} loading={loading}>
                Tenant Olustur
              </Button>
            )}
          </div>
        </Card>

        {/* Pricing Summary Sidebar - Only on Step 3 */}
        {currentStep === 2 && (
          <div className="w-80 flex-shrink-0">
            <Card className="p-5 sticky top-4 bg-gradient-to-br from-indigo-50 to-purple-50 border-indigo-200">
              <h4 className="font-semibold text-gray-900 mb-4">Fiyat Ozeti</h4>

              {enabledModules.length === 0 ? (
                <p className="text-sm text-gray-500">Modul secin...</p>
              ) : (
                <div className="space-y-4">
                  {/* Selected Modules */}
                  <div className="space-y-2">
                    {enabledModules.map((config) => (
                      <div key={config.moduleId} className="flex items-center justify-between text-sm">
                        <span className="text-gray-600 truncate">{config.moduleName}</span>
                        <Badge variant="info" size="sm">Aktif</Badge>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-indigo-200 pt-4">
                    {/* Always show calculated total - no loading state needed */}
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-500">Ara Toplam</span>
                      <span>${calculatedTotal.toFixed(2)}</span>
                    </div>
                    {priceCalculation && (priceCalculation.tierDiscount || 0) > 0 && (
                      <div className="flex justify-between text-sm text-green-600 mb-1">
                        <span>Tier Indirimi</span>
                        <span>-${priceCalculation.tierDiscount.toFixed(2)}</span>
                      </div>
                    )}
                    {priceCalculation?.discount && priceCalculation.discount.amount > 0 && (
                      <div className="flex justify-between text-sm text-green-600 mb-1">
                        <span>{priceCalculation.discount.description || 'Indirim'}</span>
                        <span>-${priceCalculation.discount.amount.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-baseline pt-3 border-t border-indigo-200 mt-3">
                      <span className="font-semibold text-gray-900">Aylik Toplam</span>
                      <div className="text-right">
                        <span className="text-2xl font-bold text-indigo-600">
                          ${calculatedTotal.toFixed(2)}
                        </span>
                        <span className="text-sm text-gray-500">/ay</span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-gray-400 pt-2">
                    * Fiyatlar KDV haric gosterilmektedir
                  </p>
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
