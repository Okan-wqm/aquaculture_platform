/**
 * Custom Plan Builder Page
 *
 * Interactive plan builder for creating tenant-specific custom plans.
 * Allows selecting modules, configuring quantities, and real-time pricing calculation.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  billingApi,
  ModulePricingWithModule,
  PricingMetricType,
  PlanTier,
  BillingCycle,
  ModuleQuantities,
  PricingCalculation,
  CustomPlan,
  CustomPlanStatus,
} from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface SelectedModule {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  quantities: ModuleQuantities;
}

interface PlanConfig {
  tenantId: string;
  name: string;
  description: string;
  tier: PlanTier;
  billingCycle: BillingCycle;
  modules: SelectedModule[];
  discountPercent: number;
  discountAmount: number;
  discountReason: string;
  validFrom: string;
  validTo: string;
  notes: string;
}

// ============================================================================
// Metric Labels
// ============================================================================

const METRIC_LABELS: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: 'Base Price',
  [PricingMetricType.PER_USER]: 'Users',
  [PricingMetricType.PER_FARM]: 'Farms',
  [PricingMetricType.PER_POND]: 'Ponds/Tanks',
  [PricingMetricType.PER_SENSOR]: 'Sensors',
  [PricingMetricType.PER_DEVICE]: 'Devices',
  [PricingMetricType.PER_GB_STORAGE]: 'Storage (GB)',
  [PricingMetricType.PER_API_CALL]: 'API Calls',
  [PricingMetricType.PER_ALERT]: 'Alerts',
  [PricingMetricType.PER_REPORT]: 'Reports',
  [PricingMetricType.PER_SMS]: 'SMS',
  [PricingMetricType.PER_EMAIL]: 'Emails',
  [PricingMetricType.PER_INTEGRATION]: 'Integrations',
};

const QUANTITY_FIELD_MAP: Partial<Record<PricingMetricType, keyof ModuleQuantities>> = {
  [PricingMetricType.PER_USER]: 'users',
  [PricingMetricType.PER_FARM]: 'farms',
  [PricingMetricType.PER_POND]: 'ponds',
  [PricingMetricType.PER_SENSOR]: 'sensors',
  [PricingMetricType.PER_DEVICE]: 'devices',
  [PricingMetricType.PER_GB_STORAGE]: 'storageGb',
  [PricingMetricType.PER_API_CALL]: 'apiCalls',
  [PricingMetricType.PER_ALERT]: 'alerts',
  [PricingMetricType.PER_REPORT]: 'reports',
  [PricingMetricType.PER_INTEGRATION]: 'integrations',
};

// ============================================================================
// Custom Plan Builder Page
// ============================================================================

const CustomPlanBuilderPage: React.FC = () => {
  const [availableModules, setAvailableModules] = useState<ModulePricingWithModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pricing, setPricing] = useState<PricingCalculation | null>(null);

  const [config, setConfig] = useState<PlanConfig>({
    tenantId: '',
    name: '',
    description: '',
    tier: PlanTier.PROFESSIONAL,
    billingCycle: BillingCycle.MONTHLY,
    modules: [],
    discountPercent: 0,
    discountAmount: 0,
    discountReason: '',
    validFrom: new Date().toISOString().split('T')[0],
    validTo: '',
    notes: '',
  });

  useEffect(() => {
    loadModulePricings();
  }, []);

  const loadModulePricings = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await billingApi.getModulePricingWithModules();
      setAvailableModules(data);
    } catch (err) {
      console.error('Failed to load module pricings:', err);
      setAvailableModules([]);
      setError('Failed to load module pricing. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const calculatePricing = useCallback(async () => {
    if (config.modules.length === 0) {
      setPricing(null);
      return;
    }

    setCalculating(true);
    try {
      const result = await billingApi.calculatePricing({
        modules: config.modules.map((m) => ({
          moduleId: m.moduleId,
          moduleCode: m.moduleCode,
          moduleName: m.moduleName,
          quantities: m.quantities,
        })),
        tier: config.tier,
        billingCycle: config.billingCycle,
      });
      setPricing(result);
    } catch (err) {
      // Calculate locally if API fails
      const localTotal = calculateLocalPricing();
      setPricing({
        modules: [],
        subtotal: localTotal,
        tierDiscount: 0,
        discount: { amount: 0, percent: 0 },
        tax: 0,
        taxRate: 0,
        total: localTotal,
        monthlyTotal: localTotal,
        annualTotal: localTotal * 12,
        billingCycle: config.billingCycle,
        billingCycleMultiplier: 1,
        currency: 'USD',
        tier: config.tier,
        calculatedAt: new Date().toISOString(),
      });
    } finally {
      setCalculating(false);
    }
  }, [config.modules, config.tier, config.billingCycle]);

  useEffect(() => {
    const timer = setTimeout(() => {
      calculatePricing();
    }, 500);
    return () => clearTimeout(timer);
  }, [calculatePricing]);

  const calculateLocalPricing = (): number => {
    let total = 0;
    const tierMultiplier = config.tier === PlanTier.ENTERPRISE ? 0.7 : config.tier === PlanTier.PROFESSIONAL ? 0.9 : 1.0;

    for (const selectedModule of config.modules) {
      const modulePricing = availableModules.find((m) => m.moduleCode === selectedModule.moduleCode);
      if (!modulePricing) continue;

      for (const metric of modulePricing.pricingMetrics) {
        if (metric.type === PricingMetricType.BASE_PRICE) {
          total += metric.price * tierMultiplier;
        } else {
          const field = QUANTITY_FIELD_MAP[metric.type];
          if (field) {
            const qty = selectedModule.quantities[field] || 0;
            const included = metric.includedQuantity || 0;
            const billable = Math.max(0, qty - included);
            total += billable * metric.price * tierMultiplier;
          }
        }
      }
    }

    return total;
  };

  const toggleModule = (module: ModulePricingWithModule) => {
    const isSelected = config.modules.some((m) => m.moduleCode === module.moduleCode);

    if (isSelected) {
      setConfig({
        ...config,
        modules: config.modules.filter((m) => m.moduleCode !== module.moduleCode),
      });
    } else {
      // Initialize with default quantities
      const defaultQuantities: ModuleQuantities = {};
      module.pricingMetrics.forEach((metric) => {
        const field = QUANTITY_FIELD_MAP[metric.type];
        if (field) {
          defaultQuantities[field] = metric.includedQuantity || 1;
        }
      });

      setConfig({
        ...config,
        modules: [
          ...config.modules,
          {
            moduleId: module.moduleId,
            moduleCode: module.moduleCode,
            moduleName: module.moduleName || module.moduleCode,
            quantities: defaultQuantities,
          },
        ],
      });
    }
  };

  const updateModuleQuantity = (moduleCode: string, field: keyof ModuleQuantities, value: number) => {
    setConfig({
      ...config,
      modules: config.modules.map((m) =>
        m.moduleCode === moduleCode
          ? { ...m, quantities: { ...m.quantities, [field]: value } }
          : m
      ),
    });
  };

  const handleSavePlan = async () => {
    if (!config.tenantId || !config.name || config.modules.length === 0) {
      setError('Please fill in all required fields and select at least one module.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await billingApi.createCustomPlan({
        tenantId: config.tenantId,
        name: config.name,
        description: config.description,
        tier: config.tier,
        billingCycle: config.billingCycle,
        modules: config.modules,
        discountPercent: config.discountPercent,
        discountAmount: config.discountAmount,
        discountReason: config.discountReason,
        validFrom: config.validFrom,
        validTo: config.validTo || undefined,
        notes: config.notes,
        createdBy: 'admin',
      });
      setSuccess('Custom plan created successfully!');
      // Reset form
      setConfig({
        ...config,
        name: '',
        description: '',
        modules: [],
        discountPercent: 0,
        discountAmount: 0,
        discountReason: '',
        notes: '',
      });
    } catch (err) {
      setError((err as Error).message || 'Failed to create custom plan');
    } finally {
      setSaving(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Custom Plan Builder</h1>
          <p className="mt-1 text-sm text-gray-500">
            Create custom plans for tenants with specific module configurations
          </p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <Card className="p-4 bg-red-50 border-red-200">
          <div className="text-red-700">{error}</div>
        </Card>
      )}
      {success && (
        <Card className="p-4 bg-green-50 border-green-200">
          <div className="text-green-700">{success}</div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Configuration */}
        <div className="lg:col-span-2 space-y-6">
          {/* Plan Details */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Plan Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tenant ID <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="tenant-uuid"
                  value={config.tenantId}
                  onChange={(e) => setConfig({ ...config, tenantId: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Plan Name <span className="text-red-500">*</span>
                </label>
                <Input
                  placeholder="Custom Plan for Acme Corp"
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <Input
                  placeholder="Description..."
                  value={config.description}
                  onChange={(e) => setConfig({ ...config, description: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tier</label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={config.tier}
                  onChange={(e) => setConfig({ ...config, tier: e.target.value as PlanTier })}
                >
                  <option value={PlanTier.STARTER}>Starter (Full Price)</option>
                  <option value={PlanTier.PROFESSIONAL}>Professional (10% off)</option>
                  <option value={PlanTier.ENTERPRISE}>Enterprise (30% off)</option>
                  <option value={PlanTier.CUSTOM}>Custom</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Billing Cycle</label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={config.billingCycle}
                  onChange={(e) => setConfig({ ...config, billingCycle: e.target.value as BillingCycle })}
                >
                  <option value={BillingCycle.MONTHLY}>Monthly</option>
                  <option value={BillingCycle.QUARTERLY}>Quarterly (5% off)</option>
                  <option value={BillingCycle.SEMI_ANNUAL}>Semi-Annual (10% off)</option>
                  <option value={BillingCycle.ANNUAL}>Annual (15% off)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Valid From</label>
                <Input
                  type="date"
                  value={config.validFrom}
                  onChange={(e) => setConfig({ ...config, validFrom: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Valid To (Optional)</label>
                <Input
                  type="date"
                  value={config.validTo}
                  onChange={(e) => setConfig({ ...config, validTo: e.target.value })}
                />
              </div>
            </div>
          </Card>

          {/* Module Selection */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Select Modules</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {availableModules.map((module) => {
                const isSelected = config.modules.some((m) => m.moduleCode === module.moduleCode);
                const basePrice = module.pricingMetrics.find(
                  (m) => m.type === PricingMetricType.BASE_PRICE
                )?.price || 0;

                return (
                  <div
                    key={module.moduleCode}
                    className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => toggleModule(module)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-2xl">{module.moduleIcon || '📦'}</div>
                      <div className="flex-1">
                        <div className="font-medium">{module.moduleName}</div>
                        <div className="text-sm text-gray-500">{formatCurrency(basePrice)}/mo base</div>
                      </div>
                      {isSelected && (
                        <svg className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Module Configuration */}
          {config.modules.length > 0 && (
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">Configure Quantities</h2>
              <div className="space-y-6">
                {config.modules.map((selectedModule) => {
                  const modulePricing = availableModules.find(
                    (m) => m.moduleCode === selectedModule.moduleCode
                  );
                  if (!modulePricing) return null;

                  return (
                    <div key={selectedModule.moduleCode} className="p-4 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-xl">{modulePricing.moduleIcon || '📦'}</span>
                        <span className="font-medium">{modulePricing.moduleName}</span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {modulePricing.pricingMetrics
                          .filter((m) => m.type !== PricingMetricType.BASE_PRICE)
                          .map((metric) => {
                            const field = QUANTITY_FIELD_MAP[metric.type];
                            if (!field) return null;

                            return (
                              <div key={metric.type}>
                                <label className="block text-xs text-gray-500 mb-1">
                                  {METRIC_LABELS[metric.type]}
                                  {metric.includedQuantity && (
                                    <span className="text-green-600 ml-1">
                                      ({metric.includedQuantity} free)
                                    </span>
                                  )}
                                </label>
                                <Input
                                  type="number"
                                  min={0}
                                  value={selectedModule.quantities[field] || 0}
                                  onChange={(e) =>
                                    updateModuleQuantity(
                                      selectedModule.moduleCode,
                                      field,
                                      parseInt(e.target.value) || 0
                                    )
                                  }
                                />
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Discounts */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Discounts (Optional)</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Discount %</label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={config.discountPercent}
                  onChange={(e) =>
                    setConfig({ ...config, discountPercent: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fixed Discount ($)</label>
                <Input
                  type="number"
                  min={0}
                  value={config.discountAmount}
                  onChange={(e) =>
                    setConfig({ ...config, discountAmount: parseFloat(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Discount Reason</label>
                <Input
                  placeholder="Early adopter discount"
                  value={config.discountReason}
                  onChange={(e) => setConfig({ ...config, discountReason: e.target.value })}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* Right Panel - Pricing Summary */}
        <div className="space-y-6">
          <Card className="p-6 sticky top-4">
            <h2 className="text-lg font-semibold mb-4">Pricing Summary</h2>

            {calculating ? (
              <div className="flex items-center justify-center h-32">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : config.modules.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                Select modules to see pricing
              </div>
            ) : (
              <>
                {/* Selected Modules */}
                <div className="space-y-3 mb-6">
                  {config.modules.map((m) => {
                    const modulePricing = availableModules.find(
                      (mp) => mp.moduleCode === m.moduleCode
                    );
                    const basePrice =
                      modulePricing?.pricingMetrics.find(
                        (metric) => metric.type === PricingMetricType.BASE_PRICE
                      )?.price || 0;

                    return (
                      <div key={m.moduleCode} className="flex justify-between text-sm">
                        <span className="text-gray-600">{m.moduleName}</span>
                        <span className="font-medium">{formatCurrency(basePrice)}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t pt-4 space-y-2">
                  {pricing && (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Subtotal</span>
                        <span>{formatCurrency(pricing.subtotal)}</span>
                      </div>
                      {pricing.tierDiscount > 0 && (
                        <div className="flex justify-between text-sm text-green-600">
                          <span>Tier Discount</span>
                          <span>-{formatCurrency(pricing.tierDiscount)}</span>
                        </div>
                      )}
                      {config.discountPercent > 0 && (
                        <div className="flex justify-between text-sm text-green-600">
                          <span>Custom Discount ({config.discountPercent}%)</span>
                          <span>
                            -{formatCurrency((pricing.monthlyTotal * config.discountPercent) / 100)}
                          </span>
                        </div>
                      )}
                      {config.discountAmount > 0 && (
                        <div className="flex justify-between text-sm text-green-600">
                          <span>Fixed Discount</span>
                          <span>-{formatCurrency(config.discountAmount)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="border-t mt-4 pt-4">
                  <div className="flex justify-between items-center">
                    <span className="text-lg font-semibold">Monthly Total</span>
                    <span className="text-2xl font-bold text-blue-600">
                      {pricing
                        ? formatCurrency(
                            Math.max(
                              0,
                              pricing.monthlyTotal -
                                (pricing.monthlyTotal * config.discountPercent) / 100 -
                                config.discountAmount
                            )
                          )
                        : '-'}
                    </span>
                  </div>
                  {pricing && (
                    <div className="text-sm text-gray-500 text-right">
                      {formatCurrency(
                        Math.max(
                          0,
                          pricing.annualTotal -
                            (pricing.annualTotal * config.discountPercent) / 100 -
                            config.discountAmount * 12
                        )
                      )}{' '}
                      /year
                    </div>
                  )}
                </div>

                {/* Tier Info */}
                <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                  <div className="text-xs text-gray-500 mb-1">Selected Tier</div>
                  <div className="font-medium capitalize">{config.tier}</div>
                  {config.tier === PlanTier.PROFESSIONAL && (
                    <div className="text-xs text-green-600">10% tier discount applied</div>
                  )}
                  {config.tier === PlanTier.ENTERPRISE && (
                    <div className="text-xs text-green-600">30% tier discount applied</div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="mt-6 space-y-3">
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={handleSavePlan}
                    disabled={saving || !config.tenantId || !config.name}
                  >
                    {saving ? 'Creating...' : 'Create Custom Plan'}
                  </Button>
                  <Button variant="outline" className="w-full">
                    Save as Draft
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

export default CustomPlanBuilderPage;
