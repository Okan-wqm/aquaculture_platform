/**
 * Storage Overview Tab - Dashboard with stats, low stock alerts, recent movements,
 * and interactive pie/donut charts for category distribution and location fill rates.
 */
import React, { useState, useMemo } from 'react';
import { DonutChart, formatCurrency, parseMoney, DEFAULT_CURRENCY } from '@aquaculture/shared-ui';
import type { PieDataItem } from '@aquaculture/shared-ui';
import { useStorageOverview, useStockMovements, useStorageInventory, StorageItemType } from '../../../hooks/useStorageInventory';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';
import { usePendingDeliveries, PurchaseOrder } from '../../../hooks/usePurchaseOrders';
import { ReceiveDeliveryModal } from './ReceiveDeliveryModal';

const movementTypeBadge: Record<string, string> = {
  IN: 'bg-green-100 text-green-800',
  OUT: 'bg-red-100 text-red-800',
  TRANSFER: 'bg-blue-100 text-blue-800',
  WASTE: 'bg-gray-100 text-gray-800',
  ADJUSTMENT: 'bg-yellow-100 text-yellow-800',
  RETURN: 'bg-purple-100 text-purple-800',
};

const CATEGORY_CONFIG: Record<string, { label: string; color: string; bgColor: string; borderColor: string }> = {
  FEED: { label: 'Feed', color: '#F59E0B', bgColor: 'bg-amber-50', borderColor: 'border-amber-200' },
  feed: { label: 'Feed', color: '#F59E0B', bgColor: 'bg-amber-50', borderColor: 'border-amber-200' },
  CHEMICAL: { label: 'Chemical', color: '#3B82F6', bgColor: 'bg-blue-50', borderColor: 'border-blue-200' },
  chemical: { label: 'Chemical', color: '#3B82F6', bgColor: 'bg-blue-50', borderColor: 'border-blue-200' },
  CONSUMABLE: { label: 'Consumable', color: '#10B981', bgColor: 'bg-green-50', borderColor: 'border-green-200' },
  consumable: { label: 'Consumable', color: '#10B981', bgColor: 'bg-green-50', borderColor: 'border-green-200' },
  HEALTHCARE: { label: 'Healthcare', color: '#8B5CF6', bgColor: 'bg-purple-50', borderColor: 'border-purple-200' },
  healthcare: { label: 'Healthcare', color: '#8B5CF6', bgColor: 'bg-purple-50', borderColor: 'border-purple-200' },
};

export const OverviewTab: React.FC = () => {
  const { data: overview, isLoading: overviewLoading } = useStorageOverview();
  const { data: movementsData } = useStockMovements();
  const { data: locations } = useStorageLocationList();
  const { data: pendingDeliveries } = usePendingDeliveries();
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);

  // Category filter toggles
  const [visibleCategories, setVisibleCategories] = useState<Set<string>>(
    new Set(['FEED', 'CHEMICAL', 'CONSUMABLE', 'HEALTHCARE'])
  );

  // Storage location filter
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [locationDropdownOpen, setLocationDropdownOpen] = useState(false);

  // Drill-down state: when a pie slice is clicked, show that category's items
  const [drillDownCategory, setDrillDownCategory] = useState<string | null>(null);

  // Map drilldown category to StorageItemType
  const drillDownItemType = useMemo(() => {
    if (!drillDownCategory) return undefined;
    const upper = drillDownCategory.toUpperCase();
    if (upper === 'FEED') return StorageItemType.FEED;
    if (upper === 'CHEMICAL') return StorageItemType.CHEMICAL;
    if (upper === 'CONSUMABLE') return StorageItemType.CONSUMABLE;
    if (upper === 'HEALTHCARE') return 'HEALTHCARE' as StorageItemType;
    return undefined;
  }, [drillDownCategory]);

  const { data: drillDownItems, isLoading: drillDownLoading } = useStorageInventory(
    undefined,
    drillDownItemType
  );

  const recentMovements = (movementsData?.items || []).slice(0, 5);

  // Filtered category data for the donut chart
  const categoryChartData = useMemo((): PieDataItem[] => {
    const totals = overview?.categoryTotals || [];
    return totals
      .filter(cat => visibleCategories.has(cat.category.toUpperCase()))
      .map(cat => ({
        label: CATEGORY_CONFIG[cat.category]?.label || cat.category,
        value: cat.totalQuantity,
        color: CATEGORY_CONFIG[cat.category]?.color || '#6B7280',
      }));
  }, [overview?.categoryTotals, visibleCategories]);

  // Category value chart data
  const categoryValueChartData = useMemo((): PieDataItem[] => {
    const totals = overview?.categoryTotals || [];
    return totals
      .filter(cat => visibleCategories.has(cat.category.toUpperCase()))
      .map(cat => ({
        label: CATEGORY_CONFIG[cat.category]?.label || cat.category,
        value: parseMoney(cat.totalValueDecimal),
        color: CATEGORY_CONFIG[cat.category]?.color || '#6B7280',
      }));
  }, [overview?.categoryTotals, visibleCategories]);

  // Location fill rate chart data (filtered by selected locations)
  const locationChartData = useMemo((): PieDataItem[] => {
    const rates = overview?.locationFillRates || [];
    const filtered = selectedLocationIds.size > 0
      ? rates.filter(loc => selectedLocationIds.has(loc.locationId))
      : rates;
    return filtered.map(loc => ({
      label: loc.locationName,
      value: loc.usedCapacity,
      color: loc.fillPercentage > 90 ? '#EF4444' : loc.fillPercentage > 70 ? '#F59E0B' : '#3B82F6',
    }));
  }, [overview?.locationFillRates, selectedLocationIds]);

  const toggleCategory = (cat: string) => {
    setVisibleCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) {
        if (next.size > 1) next.delete(cat); // Keep at least one
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const toggleLocation = (id: string) => {
    setSelectedLocationIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (overviewLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Total Stock Value</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(parseMoney(overview?.totalStockValueDecimal), DEFAULT_CURRENCY)}</div>
          <div className="mt-1 text-xs text-gray-400">{overview?.totalItems || 0} items</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Low Stock Alerts</div>
          <div className="mt-1 text-2xl font-bold text-red-600">{overview?.lowStockAlertCount || 0}</div>
          <div className="mt-1 text-xs text-gray-400">Items below minimum threshold</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Recent Movements</div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{overview?.recentMovementsCount || 0}</div>
          <div className="mt-1 text-xs text-gray-400">Last 7 days</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="text-sm font-medium text-gray-500">Storage Locations</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{overview?.locationFillRates?.length || 0}</div>
          <div className="mt-1 text-xs text-gray-400">Active locations</div>
        </div>
      </div>

      {/* Pending Deliveries Alert Banner */}
      {(pendingDeliveries || []).length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-amber-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-amber-800">
                  {pendingDeliveries!.length} delivery {pendingDeliveries!.length === 1 ? 'is' : 'deliveries are'} expected today or overdue
                </h4>
                <div className="mt-1 flex flex-wrap gap-2">
                  {pendingDeliveries!.slice(0, 3).map(po => (
                    <button key={po.id}
                      onClick={() => setReceiveTarget(po)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-white border border-amber-300 rounded-full text-amber-700 hover:bg-amber-100 transition-colors">
                      {po.orderNumber} - {po.supplierName}
                      <span className="text-amber-500">Mark Received</span>
                    </button>
                  ))}
                  {pendingDeliveries!.length > 3 && (
                    <span className="text-xs text-amber-600 py-1">+{pendingDeliveries!.length - 3} more</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Stock Distribution by Category - Donut Chart */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">Stock Distribution by Category</h3>
          </div>

          {/* Category filter checkboxes */}
          <div className="flex gap-3 mb-4">
            {(['FEED', 'CHEMICAL', 'CONSUMABLE', 'HEALTHCARE'] as const).map(cat => (
              <label
                key={cat}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer border transition-all ${
                  visibleCategories.has(cat)
                    ? `${CATEGORY_CONFIG[cat].bgColor} ${CATEGORY_CONFIG[cat].borderColor}`
                    : 'bg-gray-50 border-gray-200 text-gray-400'
                }`}
              >
                <input
                  type="checkbox"
                  checked={visibleCategories.has(cat)}
                  onChange={() => toggleCategory(cat)}
                  className="sr-only"
                />
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: visibleCategories.has(cat) ? CATEGORY_CONFIG[cat].color : '#D1D5DB' }}
                />
                {CATEGORY_CONFIG[cat].label}
              </label>
            ))}
          </div>

          {categoryChartData.length > 0 ? (
            <div className="flex justify-center">
              <DonutChart
                data={categoryChartData}
                size={220}
                thickness={40}
                showLegend
                showTooltip
                showPercentages
                formatValue={(v) => `${v.toLocaleString()} units`}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              No inventory data available
            </div>
          )}

          {/* Click hint */}
          {categoryChartData.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 justify-center">
              {(overview?.categoryTotals || [])
                .filter(cat => visibleCategories.has(cat.category.toUpperCase()))
                .map(cat => (
                  <button
                    key={cat.category}
                    onClick={() => setDrillDownCategory(
                      drillDownCategory === cat.category ? null : cat.category
                    )}
                    className={`text-xs px-3 py-1 rounded-full border transition-all ${
                      drillDownCategory === cat.category
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {CATEGORY_CONFIG[cat.category]?.label || cat.category}: {cat.itemCount} items
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Stock Value by Category - Donut Chart */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">Stock Value by Category</h3>
          </div>

          {categoryValueChartData.length > 0 && categoryValueChartData.some(d => d.value > 0) ? (
            <div className="flex justify-center" style={{ marginTop: 36 }}>
              <DonutChart
                data={categoryValueChartData}
                size={220}
                thickness={40}
                showLegend
                showTooltip
                showPercentages
                formatValue={(v) => formatCurrency(v)}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              No value data available
            </div>
          )}
        </div>
      </div>

      {/* Drill-down panel */}
      {drillDownCategory && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {CATEGORY_CONFIG[drillDownCategory]?.label || drillDownCategory} Inventory Details
            </h3>
            <button
              onClick={() => setDrillDownCategory(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {drillDownLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-4 border-blue-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Item</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lot</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Quantity</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expiry</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {(drillDownItems || []).map(item => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 text-sm font-medium text-gray-900">{item.itemName || '-'}</td>
                      <td className="px-6 py-3 text-sm text-gray-500">{item.locationName || '-'}</td>
                      <td className="px-6 py-3 text-sm text-gray-500 font-mono">{item.lotNumber || '-'}</td>
                      <td className="px-6 py-3 text-sm font-medium text-gray-900">{item.quantity} {item.unit}</td>
                      <td className="px-6 py-3 text-sm text-gray-500">
                        {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString('nb-NO') : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(drillDownItems || []).length === 0 && (
                <div className="text-center py-8 text-sm text-gray-500">No items in this category.</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Low Stock Alerts */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Low Stock Alerts</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {(overview?.lowStockAlerts || []).length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500">No low stock alerts</div>
            ) : (
              overview?.lowStockAlerts.map((alert, idx) => (
                <div key={`${alert.itemId}-${idx}`} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{alert.itemName}</div>
                    <div className="text-xs text-gray-500">{alert.itemType}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm">
                      <span className={alert.currentQuantity === 0 ? 'text-red-600 font-semibold' : 'text-yellow-600 font-medium'}>
                        {alert.currentQuantity}
                      </span>
                      <span className="text-gray-400"> / {alert.minStock} {alert.unit}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Movements */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-900">Recent Movements</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {recentMovements.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500">No recent movements</div>
            ) : (
              recentMovements.map(m => (
                <div key={m.id} className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${movementTypeBadge[m.movementType] || 'bg-gray-100 text-gray-800'}`}>
                      {m.movementType}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{m.itemName}</div>
                      <div className="text-xs text-gray-500">{m.performedBy}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">
                      {m.movementType === 'OUT' || m.movementType === 'WASTE' ? '-' : '+'}{m.quantity} {m.unit}
                    </div>
                    <div className="text-xs text-gray-500">
                      {new Date(m.performedAt).toLocaleDateString('nb-NO', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Location Fill Rates - Donut Chart + Bars */}
      {(overview?.locationFillRates || []).length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">Location Fill Rates</h3>

            {/* Location filter dropdown */}
            {(locations?.items || []).length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setLocationDropdownOpen(!locationDropdownOpen)}
                  className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-1"
                >
                  {selectedLocationIds.size > 0 ? `${selectedLocationIds.size} selected` : 'All locations'}
                  <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {locationDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setLocationDropdownOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 bg-white rounded-lg border border-gray-200 shadow-lg py-1 min-w-[200px] max-h-60 overflow-y-auto">
                      {selectedLocationIds.size > 0 && (
                        <button
                          onClick={() => { setSelectedLocationIds(new Set()); setLocationDropdownOpen(false); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-50"
                        >
                          Clear selection
                        </button>
                      )}
                      {(locations?.items || []).map((loc: any) => (
                        <label key={loc.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedLocationIds.has(loc.id)}
                            onChange={() => toggleLocation(loc.id)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-xs text-gray-700">{loc.name}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Donut chart */}
            {locationChartData.length > 0 && (
              <div className="flex justify-center items-center">
                <DonutChart
                  data={locationChartData}
                  size={200}
                  thickness={35}
                  showLegend={false}
                  showTooltip
                  formatValue={(v) => `${v.toLocaleString()} used`}
                />
              </div>
            )}

            {/* Bar fill rates */}
            <div className="space-y-3">
              {(selectedLocationIds.size > 0
                ? overview?.locationFillRates.filter(loc => selectedLocationIds.has(loc.locationId))
                : overview?.locationFillRates
              )?.map(loc => (
                <div key={loc.locationId} className="flex items-center gap-4">
                  <div className="w-32 text-sm font-medium text-gray-900 truncate">{loc.locationName}</div>
                  <div className="flex-1">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-500 ${loc.fillPercentage > 90 ? 'bg-red-500' : loc.fillPercentage > 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(loc.fillPercentage, 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-20 text-right text-xs text-gray-500">
                    {loc.usedCapacity} / {loc.capacity || 0}
                  </div>
                  <div className="w-10 text-right text-xs font-medium text-gray-700">{Math.round(loc.fillPercentage)}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <ReceiveDeliveryModal isOpen={!!receiveTarget} onClose={() => setReceiveTarget(null)} purchaseOrder={receiveTarget} />
    </div>
  );
};

export default OverviewTab;
