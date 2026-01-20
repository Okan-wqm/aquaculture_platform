/**
 * Discount Code Management Page
 *
 * Admin panel for managing discount codes and promotions.
 */

import React, { useState, useEffect } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import {
  billingApi,
  DiscountCode,
  DiscountStats,
  DiscountType,
  DiscountAppliesTo,
  DiscountDuration,
  CreateDiscountCodeDto,
} from '../services/adminApi';

// ============================================================================
// Discount Code Management Page
// ============================================================================

const DiscountCodePage: React.FC = () => {
  const [discountCodes, setDiscountCodes] = useState<DiscountCode[]>([]);
  const [stats, setStats] = useState<DiscountStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [showActive, setShowActive] = useState(true);
  const [showExpired, setShowExpired] = useState(false);

  // Create modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCode, setNewCode] = useState<Partial<CreateDiscountCodeDto>>({
    code: '',
    name: '',
    description: '',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    appliesTo: DiscountAppliesTo.ALL_PLANS,
    duration: DiscountDuration.ONCE,
    createdBy: 'admin',
  });

  useEffect(() => {
    loadData();
  }, [showActive, showExpired]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [codesResult, statsResult] = await Promise.all([
        billingApi.getDiscountCodes({
          isActive: showActive || undefined,
          includeExpired: showExpired,
        }),
        billingApi.getDiscountStats(),
      ]);
      setDiscountCodes(codesResult);
      setStats(statsResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateCode = async () => {
    try {
      const result = await billingApi.generateUniqueCode('PROMO', 8);
      setNewCode({ ...newCode, code: result.code });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreateCode = async () => {
    if (!newCode.code || !newCode.name || !newCode.discountValue) {
      setError('Please fill in all required fields');
      return;
    }

    try {
      await billingApi.createDiscountCode(newCode as CreateDiscountCodeDto);
      setShowCreateModal(false);
      setNewCode({
        code: '',
        name: '',
        description: '',
        discountType: DiscountType.PERCENTAGE,
        discountValue: 10,
        appliesTo: DiscountAppliesTo.ALL_PLANS,
        duration: DiscountDuration.ONCE,
        createdBy: 'admin',
      });
      loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm('Are you sure you want to deactivate this discount code?')) return;

    try {
      await billingApi.deactivateDiscountCode(id, 'admin');
      loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const getDiscountTypeLabel = (type: DiscountType): string => {
    const labels: Record<DiscountType, string> = {
      [DiscountType.PERCENTAGE]: 'Percentage',
      [DiscountType.FIXED_AMOUNT]: 'Fixed Amount',
      [DiscountType.FREE_TRIAL_EXTENSION]: 'Trial Extension',
      [DiscountType.FREE_MONTHS]: 'Free Months',
    };
    return labels[type];
  };

  const formatDiscountValue = (code: DiscountCode): string => {
    switch (code.discountType) {
      case DiscountType.PERCENTAGE:
        return `${code.discountValue}%`;
      case DiscountType.FIXED_AMOUNT:
        return `$${code.discountValue}`;
      case DiscountType.FREE_TRIAL_EXTENSION:
        return `+${code.discountValue} days`;
      case DiscountType.FREE_MONTHS:
        return `${code.discountValue} months free`;
      default:
        return String(code.discountValue);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const isExpired = (code: DiscountCode): boolean => {
    if (!code.validUntil) return false;
    return new Date(code.validUntil) < new Date();
  };

  const isMaxedOut = (code: DiscountCode): boolean => {
    if (!code.maxRedemptions) return false;
    return code.currentRedemptions >= code.maxRedemptions;
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
          <h1 className="text-2xl font-bold text-gray-900">Discount Codes</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage promotional codes and discounts
          </p>
        </div>
        <div className="mt-4 sm:mt-0">
          <Button onClick={() => setShowCreateModal(true)}>
            Create Discount Code
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Total Codes</div>
            <div className="mt-1 text-2xl font-bold text-gray-900">
              {stats.totalCodes}
            </div>
            <div className="text-xs text-gray-400">
              Active: {stats.activeCodes}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Total Redemptions</div>
            <div className="mt-1 text-2xl font-bold text-blue-600">
              {stats.totalRedemptions}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Total Discount Given</div>
            <div className="mt-1 text-2xl font-bold text-green-600">
              ${stats.totalDiscountAmount.toLocaleString()}
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium text-gray-500">Expired Codes</div>
            <div className="mt-1 text-2xl font-bold text-orange-600">
              {stats.expiredCodes}
            </div>
          </Card>
        </div>
      )}

      {/* Top Codes */}
      {stats && stats.topCodes.length > 0 && (
        <Card className="p-4">
          <h3 className="text-lg font-semibold mb-4">Top Performing Codes</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {stats.topCodes.map((top, idx) => (
              <div key={top.code} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
                  {idx + 1}
                </div>
                <div>
                  <div className="font-mono text-sm font-medium">{top.code}</div>
                  <div className="text-xs text-gray-500">
                    {top.redemptions} uses | ${top.totalDiscount.toFixed(0)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card className="p-4">
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showActive}
              onChange={(e) => setShowActive(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-sm">Active Only</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showExpired}
              onChange={(e) => setShowExpired(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-sm">Include Expired</span>
          </label>
        </div>
      </Card>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-4 text-red-500 hover:text-red-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Discount Codes Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Code
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Discount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Applies To
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Duration
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Usage
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Validity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {discountCodes.map((code) => (
                <tr key={code.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="font-mono font-medium text-gray-900">{code.code}</div>
                    <div className="text-sm text-gray-500">{code.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-lg font-bold text-green-600">
                      {formatDiscountValue(code)}
                    </div>
                    <div className="text-xs text-gray-500">
                      {getDiscountTypeLabel(code.discountType)}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge variant="default">
                      {code.appliesTo.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge variant="info">
                      {code.duration}
                      {code.durationInMonths && ` (${code.durationInMonths} months)`}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm">
                      {code.currentRedemptions}
                      {code.maxRedemptions ? ` / ${code.maxRedemptions}` : ' / -'}
                    </div>
                    {code.maxRedemptions && (
                      <div className="w-24 h-1.5 bg-gray-200 rounded-full mt-1">
                        <div
                          className="h-full bg-blue-600 rounded-full"
                          style={{
                            width: `${Math.min(100, (code.currentRedemptions / code.maxRedemptions) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <div>{formatDate(code.validFrom)} -</div>
                    <div>{formatDate(code.validUntil)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {!code.isActive ? (
                      <Badge variant="default">Inactive</Badge>
                    ) : isExpired(code) ? (
                      <Badge variant="warning">Expired</Badge>
                    ) : isMaxedOut(code) ? (
                      <Badge variant="warning">Maxed Out</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    {code.isActive && !isExpired(code) && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDeactivate(code.id)}
                      >
                        Deactivate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <Card className="w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold mb-4">Create Discount Code</h3>

            <div className="space-y-4">
              {/* Code */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Code *
                </label>
                <div className="flex gap-2">
                  <Input
                    value={newCode.code || ''}
                    onChange={(e) => setNewCode({ ...newCode, code: e.target.value.toUpperCase() })}
                    placeholder="PROMO2024"
                    className="flex-1"
                  />
                  <Button variant="outline" onClick={handleGenerateCode}>
                    Generate
                  </Button>
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <Input
                  value={newCode.name || ''}
                  onChange={(e) => setNewCode({ ...newCode, name: e.target.value })}
                  placeholder="Summer Sale 2024"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <Input
                  value={newCode.description || ''}
                  onChange={(e) => setNewCode({ ...newCode, description: e.target.value })}
                  placeholder="Special discount for summer campaign"
                />
              </div>

              {/* Discount Type & Value */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Discount Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    value={newCode.discountType}
                    onChange={(e) =>
                      setNewCode({ ...newCode, discountType: e.target.value as DiscountType })
                    }
                  >
                    {Object.values(DiscountType).map((type) => (
                      <option key={type} value={type}>
                        {getDiscountTypeLabel(type)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Value *
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={newCode.discountValue || ''}
                    onChange={(e) =>
                      setNewCode({ ...newCode, discountValue: parseFloat(e.target.value) || 0 })
                    }
                    placeholder={newCode.discountType === DiscountType.PERCENTAGE ? '10' : '50'}
                  />
                </div>
              </div>

              {/* Applies To & Duration */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Applies To
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    value={newCode.appliesTo}
                    onChange={(e) =>
                      setNewCode({ ...newCode, appliesTo: e.target.value as DiscountAppliesTo })
                    }
                  >
                    {Object.values(DiscountAppliesTo).map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Duration
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    value={newCode.duration}
                    onChange={(e) =>
                      setNewCode({ ...newCode, duration: e.target.value as DiscountDuration })
                    }
                  >
                    {Object.values(DiscountDuration).map((type) => (
                      <option key={type} value={type}>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Validity Period */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Valid From
                  </label>
                  <Input
                    type="date"
                    value={newCode.validFrom || ''}
                    onChange={(e) => setNewCode({ ...newCode, validFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Valid Until
                  </label>
                  <Input
                    type="date"
                    value={newCode.validUntil || ''}
                    onChange={(e) => setNewCode({ ...newCode, validUntil: e.target.value })}
                  />
                </div>
              </div>

              {/* Max Redemptions */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Total Uses
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={newCode.maxRedemptions || ''}
                    onChange={(e) =>
                      setNewCode({
                        ...newCode,
                        maxRedemptions: parseInt(e.target.value, 10) || undefined,
                      })
                    }
                    placeholder="Leave empty for unlimited"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Max Per Tenant
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={newCode.maxRedemptionsPerTenant || ''}
                    onChange={(e) =>
                      setNewCode({
                        ...newCode,
                        maxRedemptionsPerTenant: parseInt(e.target.value, 10) || undefined,
                      })
                    }
                    placeholder="Leave empty for unlimited"
                  />
                </div>
              </div>

              {/* Campaign Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Campaign ID
                  </label>
                  <Input
                    value={newCode.campaignId || ''}
                    onChange={(e) => setNewCode({ ...newCode, campaignId: e.target.value })}
                    placeholder="summer-2024"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Campaign Name
                  </label>
                  <Input
                    value={newCode.campaignName || ''}
                    onChange={(e) => setNewCode({ ...newCode, campaignName: e.target.value })}
                    placeholder="Summer Campaign 2024"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreateModal(false);
                  setNewCode({
                    code: '',
                    name: '',
                    description: '',
                    discountType: DiscountType.PERCENTAGE,
                    discountValue: 10,
                    appliesTo: DiscountAppliesTo.ALL_PLANS,
                    duration: DiscountDuration.ONCE,
                    createdBy: 'admin',
                  });
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateCode}>Create Code</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default DiscountCodePage;
