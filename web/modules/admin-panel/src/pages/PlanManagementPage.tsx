/**
 * Plan Management Page
 *
 * Admin panel for managing subscription plans and pricing.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  billingApi,
  PlanCyclePrice,
  PlanDefinition,
} from '../services/adminApi';
import { formatCurrencyAmount } from '../utils/money';

/**
 * The plan's price on ONE cycle (ADR-0013). `billing.plans` prices per cycle
 * now, and a plan sold only annually has no monthly row — the previous
 * `plan.pricing.monthly.basePrice` read a fixed four-cycle object that always
 * existed and so always rendered a price, zero or not.
 */
const cyclePrice = (
  plan: PlanDefinition,
  billingCycle: PlanCyclePrice['billingCycle'],
): PlanCyclePrice | undefined =>
  plan.cyclePrices.find((price) => price.billingCycle === billingCycle);

const TIER_COLORS: Readonly<Record<PlanDefinition['tier'], string>> = {
  free: 'bg-gray-100 text-gray-800',
  starter: 'bg-blue-100 text-blue-800',
  professional: 'bg-purple-100 text-purple-800',
  enterprise: 'bg-yellow-100 text-yellow-800',
  custom: 'bg-pink-100 text-pink-800',
};

const CYCLE_LABELS: Readonly<Record<PlanCyclePrice['billingCycle'], string>> = {
  monthly: 'aylik',
  quarterly: '3 aylik',
  semi_annual: '6 aylik',
  annual: 'yillik',
};

// ============================================================================
// Plan Management Page
// ============================================================================

const PlanManagementPage: React.FC = () => {
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanDefinition | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    loadPlans();
  }, []);

  const loadPlans = async () => {
    setLoading(true);
    try {
      const data = await billingApi.getPlans(true);
      setPlans(data);
      setError(null);
    } catch (err) {
      console.error('Failed to load plans:', err);
      setPlans([]);
      setError('Failed to load plans. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeprecatePlan = async (planId: string) => {
    if (!confirm('Are you sure you want to deprecate this plan?')) return;

    try {
      await billingApi.deprecatePlan(planId);
      loadPlans();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Keyed by the CONTRACT's tier union rather than the local enum: the plan
  // comes off the generated client, so a tier the backend adds is a compile
  // error here instead of an unstyled badge.
  const getTierColor = (tier: PlanDefinition['tier']): string => TIER_COLORS[tier];

  const formatLimitValue = (value: number) => {
    if (value === -1) return 'Unlimited';
    return value.toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
        <Button onClick={loadPlans} className="ml-4">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Plan Management</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure subscription plans, pricing, and features
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex gap-2">
          <Button variant="primary">Create New Plan</Button>
        </div>
      </div>

      {/* Pricing Info */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-blue-800">
            Her plan <strong>satildigi her donem icin ayri</strong> fiyatlandirilir. Modul bazli fiyatlandirma aktiftir.
          </span>
        </div>
      </Card>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {plans.map((plan) => (
          <Card
            key={plan.id}
            className={`p-6 relative ${!plan.isActive ? 'opacity-60' : ''} ${
              plan.isRecommended ? 'ring-2 ring-blue-500' : ''
            }`}
          >
            {/* Badge */}
            {plan.badge && (
              <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                <Badge variant="info">{plan.badge}</Badge>
              </div>
            )}

            {/* Plan Header */}
            <div className="text-center mb-4">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${getTierColor(plan.tier)}`}>
                {plan.tier.toUpperCase()}
              </span>
              <h3 className="mt-3 text-xl font-bold text-gray-900">{plan.name}</h3>
              <p className="mt-1 text-sm text-gray-500">{plan.shortDescription}</p>
            </div>

            {/* Price — the plan's own default cycle, in its own currency */}
            <div className="text-center mb-4">
              {(() => {
                const price = cyclePrice(plan, plan.defaultBillingCycle);
                return price ? (
                  <>
                    <div className="text-3xl font-bold text-gray-900">
                      {formatCurrencyAmount(price.basePrice, plan.currency)}
                    </div>
                    <div className="text-sm text-gray-500">
                      {CYCLE_LABELS[price.billingCycle]}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-500">Fiyatlandirilmamis</div>
                );
              })()}
            </div>

            {/* Key Limits */}
            <div className="space-y-2 mb-4 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Users</span>
                <span className="font-medium">{formatLimitValue(plan.limits.maxUsers)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Farms</span>
                <span className="font-medium">{formatLimitValue(plan.limits.maxFarms)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Sensors</span>
                <span className="font-medium">{formatLimitValue(plan.limits.maxSensors)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Storage</span>
                <span className="font-medium">{formatLimitValue(plan.limits.storageGB)} GB</span>
              </div>
            </div>

            {/* Features Preview */}
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-500 mb-2">KEY FEATURES</div>
              <ul className="space-y-1 text-sm">
                {plan.features.coreFeatures.slice(0, 3).map((feature, idx) => (
                  <li key={idx} className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {feature}
                  </li>
                ))}
                {plan.features.coreFeatures.length > 3 && (
                  <li className="text-gray-500 text-xs">
                    +{plan.features.coreFeatures.length - 3} more features
                  </li>
                )}
              </ul>
            </div>

            {/* Status & Actions */}
            <div className="border-t pt-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Status</span>
                {plan.isActive ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Badge variant="default">Deprecated</Badge>
                )}
              </div>
              {plan.trialDays && plan.trialDays > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Trial</span>
                  <span className="font-medium">{plan.trialDays} days</span>
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setSelectedPlan(plan);
                    setShowDetails(true);
                  }}
                >
                  Details
                </Button>
                {plan.isActive && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDeprecatePlan(plan.id)}
                  >
                    Deprecate
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Plan Details Modal */}
      {showDetails && selectedPlan && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto">
          <Card className="w-full max-w-3xl m-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-2xl font-bold">{selectedPlan.name}</h2>
                <p className="text-gray-500">{selectedPlan.description}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDetails(false);
                  setSelectedPlan(null);
                }}
              >
                Close
              </Button>
            </div>

            {/* Every cycle the plan is actually sold on — not a fixed four */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Fiyatlandirma</h3>
              {selectedPlan.cyclePrices.length === 0 ? (
                <div className="p-4 bg-gray-50 rounded-lg text-sm text-gray-500">
                  Bu plan icin fiyat tanimlanmamis.
                </div>
              ) : (
                <div className="space-y-4">
                  {selectedPlan.cyclePrices.map((price) => (
                    <div
                      key={price.billingCycle}
                      className="p-4 bg-blue-50 rounded-lg border border-blue-200"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="text-sm text-gray-500 mb-1">
                            {CYCLE_LABELS[price.billingCycle]} — Temel Fiyat
                          </div>
                          <div className="text-2xl font-bold text-blue-600">
                            {formatCurrencyAmount(price.basePrice, selectedPlan.currency)}
                          </div>
                        </div>
                        {Number(price.discountPercent) > 0 && (
                          <Badge variant="success">%{price.discountPercent} indirim</Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div className="p-3 bg-white rounded-lg">
                          <div className="text-xs text-gray-500 mb-1">Per User</div>
                          <div className="font-bold">
                            {formatCurrencyAmount(price.perUserPrice, selectedPlan.currency)}
                          </div>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <div className="text-xs text-gray-500 mb-1">Per Farm</div>
                          <div className="font-bold">
                            {formatCurrencyAmount(price.perFarmPrice, selectedPlan.currency)}
                          </div>
                        </div>
                        <div className="p-3 bg-white rounded-lg">
                          <div className="text-xs text-gray-500 mb-1">Per Module</div>
                          <div className="font-bold">
                            {formatCurrencyAmount(price.perModulePrice, selectedPlan.currency)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Priced add-ons — rows in billing.plan_add_ons, not feature strings */}
            {selectedPlan.addOns.length > 0 && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Ek Paketler</h3>
                <div className="space-y-2">
                  {selectedPlan.addOns.map((addOn) => (
                    <div
                      key={addOn.code}
                      className="p-3 bg-gray-50 rounded-lg flex items-center justify-between"
                    >
                      <div>
                        <div className="font-medium">{addOn.name}</div>
                        {addOn.description && (
                          <div className="text-xs text-gray-500">{addOn.description}</div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="font-bold">
                          {formatCurrencyAmount(addOn.price, selectedPlan.currency)}
                        </div>
                        <div className="text-xs text-gray-500">
                          {CYCLE_LABELS[addOn.billingCycle]}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Limits */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Limits</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Object.entries(selectedPlan.limits).map(([key, value]) => {
                  if (typeof value === 'boolean') return null;
                  return (
                    <div key={key} className="p-3 bg-gray-50 rounded-lg">
                      <div className="text-xs text-gray-500 mb-1">
                        {key.replace(/([A-Z])/g, ' $1').trim()}
                      </div>
                      <div className="font-bold">{formatLimitValue(value as number)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Boolean Features */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Features</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {Object.entries(selectedPlan.limits)
                  .filter(([_, value]) => typeof value === 'boolean')
                  .map(([key, value]) => (
                    <div
                      key={key}
                      className={`p-2 rounded-lg flex items-center gap-2 ${
                        value ? 'bg-green-50' : 'bg-gray-50'
                      }`}
                    >
                      {value ? (
                        <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      )}
                      <span className={`text-sm ${value ? 'text-green-800' : 'text-gray-500'}`}>
                        {key.replace(/([A-Z])/g, ' $1').trim()}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            {/* All Features */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Feature Categories</h3>
              <div className="space-y-4">
                {selectedPlan.features.coreFeatures.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-gray-500 mb-2">Core Features</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedPlan.features.coreFeatures.map((feature, idx) => (
                        <Badge key={idx} variant="default">{feature}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {selectedPlan.features.advancedFeatures.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-gray-500 mb-2">Advanced Features</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedPlan.features.advancedFeatures.map((feature, idx) => (
                        <Badge key={idx} variant="info">{feature}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {selectedPlan.features.premiumFeatures.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-gray-500 mb-2">Premium Features</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedPlan.features.premiumFeatures.map((feature, idx) => (
                        <Badge key={idx} variant="warning">{feature}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Metadata */}
            <div className="border-t pt-4 text-sm text-gray-500">
              <div className="flex gap-6">
                <div>
                  <span className="font-medium">Plan Code:</span> {selectedPlan.code}
                </div>
                <div>
                  <span className="font-medium">Trial Days:</span> {selectedPlan.trialDays || 0}
                </div>
                <div>
                  <span className="font-medium">Grace Period:</span> {selectedPlan.gracePeriodDays || 0} days
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default PlanManagementPage;
