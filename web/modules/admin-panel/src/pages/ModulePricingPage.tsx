/**
 * Module Pricing Page
 *
 * Admin panel for managing per-module pricing configurations.
 * Supports metric-based pricing with tier multipliers.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge, Input, Alert } from '@aquaculture/shared-ui';
import {
  billingApi,
  ModulePricingWithModule,
  PricingMetricType,
  PlanTier,
  TierMultipliers,
  PricingMetric,
} from '../services/adminApi';

// ============================================================================
// Metric Labels
// ============================================================================

const METRIC_LABELS: Record<PricingMetricType, string> = {
  [PricingMetricType.BASE_PRICE]: 'Base Price',
  [PricingMetricType.PER_USER]: 'Per User',
  [PricingMetricType.PER_FARM]: 'Per Farm',
  [PricingMetricType.PER_POND]: 'Per Pond/Tank',
  [PricingMetricType.PER_SENSOR]: 'Per Sensor',
  [PricingMetricType.PER_DEVICE]: 'Per Device',
  [PricingMetricType.PER_GB_STORAGE]: 'Per GB Storage',
  [PricingMetricType.PER_API_CALL]: 'Per API Call',
  [PricingMetricType.PER_ALERT]: 'Per Alert',
  [PricingMetricType.PER_REPORT]: 'Per Report',
  [PricingMetricType.PER_SMS]: 'Per SMS',
  [PricingMetricType.PER_EMAIL]: 'Per Email',
  [PricingMetricType.PER_INTEGRATION]: 'Per Integration',
};

// All available metric types for adding new metrics
const ALL_METRIC_TYPES = Object.values(PricingMetricType);

// ============================================================================
// Icon Mapping - Convert icon names to emojis
// ============================================================================

const ICON_MAP: Record<string, string> = {
  fish: '🐟',
  farm: '🐟',
  package: '📦',
  inventory: '📦',
  calculator: '🧮',
  finance: '💰',
  handshake: '🤝',
  crm: '🤝',
  'clipboard-list': '📋',
  project: '📋',
  'trending-up': '📈',
  sales: '📈',
  microscope: '🔬',
  seapod: '📡',
  users: '👥',
  hr: '👥',
  sensor: '📡',
  cpu: '📡',
  alert: '🔔',
  analytics: '📊',
  settings: '⚙️',
  database: '💾',
  default: '📦',
};

const getModuleIcon = (iconName: string | undefined | null): string => {
  if (!iconName) return ICON_MAP.default;
  const normalizedIcon = iconName.toLowerCase().trim();
  return ICON_MAP[normalizedIcon] || ICON_MAP.default;
};

// Helper to check if metric is BASE_PRICE (handles both string and enum)
const isBasePrice = (metricType: string | PricingMetricType): boolean => {
  const normalized = String(metricType).toLowerCase();
  return normalized === 'base_price' || normalized === 'base_fee';
};

// Helper to get metric label (handles both uppercase and lowercase metric types)
const getMetricLabel = (metricType: string | PricingMetricType): string => {
  // Normalize to lowercase for lookup
  const normalized = String(metricType).toLowerCase();

  // Map legacy 'base_fee' to 'base_price'
  const mappedType = normalized === 'base_fee' ? 'base_price' : normalized;

  // Find matching enum value
  const enumKey = Object.values(PricingMetricType).find(
    (v) => v.toLowerCase() === mappedType
  );

  if (enumKey && METRIC_LABELS[enumKey]) {
    return METRIC_LABELS[enumKey];
  }

  // Fallback: convert snake_case to Title Case
  return metricType
    .toString()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

// ============================================================================
// Types
// ============================================================================

interface EditablePricing {
  id: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers: TierMultipliers;
  currency: string;
  notes: string;
}

// ============================================================================
// Module Pricing Page
// ============================================================================

const ModulePricingPage: React.FC = () => {
  const [pricings, setPricings] = useState<ModulePricingWithModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedPricing, setSelectedPricing] = useState<ModulePricingWithModule | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [editForm, setEditForm] = useState<EditablePricing | null>(null);

  useEffect(() => {
    loadPricings();
  }, []);

  const loadPricings = async () => {
    setLoading(true);
    try {
      const data = await billingApi.getModulePricingWithModules();
      const safeData = Array.isArray(data) ? data : [];
      setPricings(safeData);
      setError(null);
    } catch (err) {
      console.error('Failed to load module pricings:', err);
      setError('Failed to load module pricings. Please try again.');
      setPricings([]);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: amount < 1 ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const getTierDiscount = (tier: PlanTier, multipliers: TierMultipliers) => {
    const multiplier = multipliers[tier];
    if (multiplier === undefined || multiplier === 1) return null;
    if (multiplier === 0) return 'Free';
    const discount = Math.round((1 - multiplier) * 100);
    return `${discount}% off`;
  };

  const calculateBaseMonthlyPrice = (pricing: ModulePricingWithModule): number => {
    const metrics = pricing.pricingMetrics || [];
    return metrics.reduce((sum, metric) => {
      if (isBasePrice(metric.type)) {
        return sum + (metric.price || 0);
      }
      return sum;
    }, 0);
  };

  // Open edit modal
  const handleEdit = (pricing: ModulePricingWithModule) => {
    setEditForm({
      id: pricing.id,
      moduleId: pricing.moduleId,
      moduleCode: pricing.moduleCode,
      moduleName: pricing.moduleName || pricing.moduleCode,
      pricingMetrics: [...(pricing.pricingMetrics || [])],
      tierMultipliers: { ...(pricing.tierMultipliers || {}) },
      currency: pricing.currency || 'USD',
      notes: pricing.notes || '',
    });
    setShowEdit(true);
    setError(null);
    setSuccess(null);
  };

  // Update metric price
  const handleMetricPriceChange = (metricType: PricingMetricType, value: string) => {
    if (!editForm) return;

    const price = parseFloat(value) || 0;
    const updatedMetrics = editForm.pricingMetrics.map((m) =>
      m.type === metricType ? { ...m, price } : m
    );

    setEditForm({ ...editForm, pricingMetrics: updatedMetrics });
  };

  // Update metric included quantity
  const handleMetricIncludedChange = (metricType: PricingMetricType, value: string) => {
    if (!editForm) return;

    const includedQuantity = parseInt(value) || 0;
    const updatedMetrics = editForm.pricingMetrics.map((m) =>
      m.type === metricType ? { ...m, includedQuantity } : m
    );

    setEditForm({ ...editForm, pricingMetrics: updatedMetrics });
  };

  // Update tier multiplier
  const handleTierMultiplierChange = (tier: string, value: string) => {
    if (!editForm) return;

    const multiplier = parseFloat(value) || 0;
    setEditForm({
      ...editForm,
      tierMultipliers: { ...editForm.tierMultipliers, [tier]: multiplier },
    });
  };

  // Add new metric
  const handleAddMetric = (metricType: PricingMetricType) => {
    if (!editForm) return;

    // Check if metric already exists
    if (editForm.pricingMetrics.some((m) => m.type === metricType)) {
      return;
    }

    const newMetric: PricingMetric = {
      type: metricType,
      price: 0,
      currency: 'USD',
      includedQuantity: 0,
    };

    setEditForm({
      ...editForm,
      pricingMetrics: [...editForm.pricingMetrics, newMetric],
    });
  };

  // Remove metric
  const handleRemoveMetric = (metricType: PricingMetricType) => {
    if (!editForm) return;

    // Don't allow removing BASE_PRICE
    if (isBasePrice(metricType)) return;

    setEditForm({
      ...editForm,
      pricingMetrics: editForm.pricingMetrics.filter((m) => m.type !== metricType),
    });
  };

  // Save changes
  const handleSave = async () => {
    if (!editForm) return;

    setSaving(true);
    setError(null);

    try {
      await billingApi.updateModulePricing(editForm.id, {
        pricingMetrics: editForm.pricingMetrics,
        tierMultipliers: editForm.tierMultipliers,
        notes: editForm.notes,
      });

      setSuccess(`Pricing for ${editForm.moduleName} updated successfully!`);
      setShowEdit(false);
      setEditForm(null);

      // Reload data
      await loadPricings();
    } catch (err) {
      console.error('Failed to save pricing:', err);
      setError('Failed to save pricing. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const filteredPricings = pricings.filter(
    (p) =>
      (p.moduleName?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
      p.moduleCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Get available metrics that can be added
  const getAvailableMetrics = () => {
    if (!editForm) return [];
    const existingTypes = editForm.pricingMetrics.map((m) => m.type);
    return ALL_METRIC_TYPES.filter((type) => !existingTypes.includes(type));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Module Pricing</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure per-module pricing with metric-based billing
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex gap-2">
          <Button variant="outline" onClick={loadPricings}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Success/Error Messages */}
      {success && (
        <Alert type="success" dismissible onDismiss={() => setSuccess(null)}>
          {success}
        </Alert>
      )}
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Info Banner */}
      <Card className="p-4 bg-indigo-50 border-indigo-200">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-indigo-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-indigo-800">
            <strong>Module-Based Pricing:</strong> Each module has a base price plus usage-based metrics.
            Tier multipliers apply discounts for higher plan tiers. Included quantities are free.
          </div>
        </div>
      </Card>

      {/* Search */}
      <div className="flex gap-4">
        <div className="flex-1 max-w-md">
          <Input
            placeholder="Search modules..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Pricing Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredPricings.map((pricing) => (
          <Card key={pricing.id} className="p-6">
            {/* Module Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="text-3xl">{getModuleIcon(pricing.moduleIcon)}</div>
                <div>
                  <h3 className="font-semibold text-gray-900">{pricing.moduleName || pricing.moduleCode}</h3>
                  <p className="text-xs text-gray-500">{pricing.moduleCode}</p>
                </div>
              </div>
              {pricing.isActive ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="default">Inactive</Badge>
              )}
            </div>

            {/* Base Price */}
            <div className="mb-4 p-3 bg-gray-50 rounded-lg">
              <div className="text-xs text-gray-500 mb-1">Base Price</div>
              <div className="text-2xl font-bold text-gray-900">
                {formatCurrency(calculateBaseMonthlyPrice(pricing))}
                <span className="text-sm font-normal text-gray-500">/mo</span>
              </div>
            </div>

            {/* Metrics Summary */}
            <div className="space-y-2 mb-4">
              <div className="text-xs font-medium text-gray-500 uppercase">Usage Metrics</div>
              {(pricing.pricingMetrics || [])
                .filter((m) => !isBasePrice(m.type))
                .slice(0, 4)
                .map((metric) => (
                  <div key={metric.type} className="flex justify-between text-sm">
                    <span className="text-gray-600">{getMetricLabel(metric.type)}</span>
                    <span className="font-medium">
                      {formatCurrency(metric.price)}
                      {metric.includedQuantity ? (
                        <span className="text-gray-400 text-xs ml-1">
                          ({metric.includedQuantity} free)
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              {(pricing.pricingMetrics || []).filter((m) => !isBasePrice(m.type)).length > 4 && (
                <div className="text-xs text-gray-400">
                  +{(pricing.pricingMetrics || []).filter((m) => !isBasePrice(m.type)).length - 4} more metrics
                </div>
              )}
            </div>

            {/* Tier Discounts */}
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-500 uppercase mb-2">Tier Discounts</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(pricing.tierMultipliers || {}).map(([tier, multiplier]) => {
                  const discount = getTierDiscount(tier as PlanTier, pricing.tierMultipliers || {});
                  if (!discount) return null;
                  return (
                    <span
                      key={tier}
                      className="px-2 py-1 bg-green-50 text-green-700 text-xs rounded-full"
                    >
                      {tier}: {discount}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="border-t pt-4 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => {
                  setSelectedPricing(pricing);
                  setShowDetails(true);
                }}
              >
                View Details
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleEdit(pricing)}
              >
                Edit
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {filteredPricings.length === 0 && !loading && (
        <div className="text-center py-12 text-gray-500">
          No module pricing found. {searchTerm ? 'Try adjusting your search.' : 'Module pricing data needs to be configured.'}
        </div>
      )}

      {/* Details Modal */}
      {showDetails && selectedPricing && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
          <Card className="w-full max-w-2xl m-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-3">
                <div className="text-4xl">{getModuleIcon(selectedPricing.moduleIcon)}</div>
                <div>
                  <h2 className="text-2xl font-bold">{selectedPricing.moduleName}</h2>
                  <p className="text-gray-500">{selectedPricing.moduleDescription}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowDetails(false);
                  setSelectedPricing(null);
                }}
              >
                Close
              </Button>
            </div>

            {/* All Pricing Metrics */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Pricing Metrics</h3>
              <div className="space-y-3">
                {(selectedPricing.pricingMetrics || []).map((metric) => (
                  <div
                    key={metric.type}
                    className={`p-4 rounded-lg ${
                      isBasePrice(metric.type)
                        ? 'bg-indigo-50 border border-indigo-200'
                        : 'bg-gray-50'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-medium">{getMetricLabel(metric.type)}</div>
                        {metric.description && (
                          <div className="text-sm text-gray-500">{metric.description}</div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-lg">{formatCurrency(metric.price)}</div>
                        {!isBasePrice(metric.type) && (
                          <div className="text-xs text-gray-500">per unit/mo</div>
                        )}
                      </div>
                    </div>
                    {metric.includedQuantity && metric.includedQuantity > 0 && (
                      <div className="mt-2 text-sm text-green-600">
                        {metric.includedQuantity} included free
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Tier Multipliers */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Tier Multipliers</h3>
              <div className="grid grid-cols-5 gap-2">
                {Object.entries(selectedPricing.tierMultipliers || {}).map(([tier, multiplier]) => (
                  <div key={tier} className="p-3 bg-gray-50 rounded-lg text-center">
                    <div className="text-xs text-gray-500 uppercase mb-1">{tier}</div>
                    <div className="font-bold">
                      {multiplier === 0 ? 'Free' : `${(multiplier || 1) * 100}%`}
                    </div>
                    {multiplier && multiplier < 1 && multiplier > 0 && (
                      <div className="text-xs text-green-600">
                        {Math.round((1 - multiplier) * 100)}% off
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Metadata */}
            <div className="border-t pt-4 text-sm text-gray-500 space-y-2">
              <div className="flex justify-between">
                <span>Pricing ID:</span>
                <span className="font-mono text-xs">{selectedPricing.id}</span>
              </div>
              <div className="flex justify-between">
                <span>Module Code:</span>
                <span className="font-mono">{selectedPricing.moduleCode}</span>
              </div>
              <div className="flex justify-between">
                <span>Effective From:</span>
                <span>{new Date(selectedPricing.effectiveFrom).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Version:</span>
                <span>{selectedPricing.version}</span>
              </div>
            </div>

            {/* Edit Button */}
            <div className="mt-6 flex justify-end">
              <Button
                variant="primary"
                onClick={() => {
                  setShowDetails(false);
                  handleEdit(selectedPricing);
                }}
              >
                Edit Pricing
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && editForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
          <Card className="w-full max-w-3xl m-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-2xl font-bold">Edit Module Pricing</h2>
                <p className="text-gray-500">{editForm.moduleName} ({editForm.moduleCode})</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowEdit(false);
                  setEditForm(null);
                }}
              >
                Cancel
              </Button>
            </div>

            {/* Pricing Metrics */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Pricing Metrics</h3>
              <div className="space-y-4">
                {editForm.pricingMetrics.map((metric) => (
                  <div
                    key={metric.type}
                    className={`p-4 rounded-lg border ${
                      isBasePrice(metric.type)
                        ? 'bg-indigo-50 border-indigo-200'
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-3">
                      <div className="font-medium">{getMetricLabel(metric.type)}</div>
                      {!isBasePrice(metric.type) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveMetric(metric.type)}
                          className="text-red-600 hover:text-red-700"
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">Price (USD)</label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={metric.price}
                          onChange={(e) => handleMetricPriceChange(metric.type, e.target.value)}
                        />
                      </div>
                      {!isBasePrice(metric.type) && (
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">Included Free</label>
                          <Input
                            type="number"
                            min="0"
                            value={metric.includedQuantity || 0}
                            onChange={(e) => handleMetricIncludedChange(metric.type, e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add New Metric */}
              {getAvailableMetrics().length > 0 && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Add Metric</label>
                  <div className="flex flex-wrap gap-2">
                    {getAvailableMetrics().map((type) => (
                      <Button
                        key={type}
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddMetric(type)}
                      >
                        + {getMetricLabel(type)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Tier Multipliers */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Tier Multipliers</h3>
              <p className="text-sm text-gray-500 mb-3">
                Set the price multiplier for each tier. 1.0 = full price, 0.9 = 10% discount, 0 = free
              </p>
              <div className="grid grid-cols-5 gap-3">
                {Object.entries(editForm.tierMultipliers).map(([tier, multiplier]) => (
                  <div key={tier}>
                    <label className="block text-xs text-gray-500 uppercase mb-1">{tier}</label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={multiplier}
                      onChange={(e) => handleTierMultiplierChange(tier, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
              <textarea
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                rows={3}
                value={editForm.notes}
                onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                placeholder="Add any notes about this pricing configuration..."
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t pt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setShowEdit(false);
                  setEditForm(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default ModulePricingPage;
