/**
 * Storage Overview Tab - Dashboard with stats, low stock alerts, recent movements,
 * and interactive pie/donut charts for category distribution and location fill rates.
 */
import React, { useState, useMemo, useRef } from 'react';
import {
  Button,
  colors,
  DataTable,
  DEFAULT_CURRENCY,
  DonutChart,
  formatCurrency,
  parseMoney,
  Spinner,
  ToggleButton,
  useClickOutside,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import type { PieDataItem } from '@aquaculture/shared-ui';
import {
  useStorageOverview,
  useStockMovements,
  useStorageInventory,
  StorageItemType,
} from '../../../hooks/useStorageInventory';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';
import { usePendingDeliveries, PurchaseOrder } from '../../../hooks/usePurchaseOrders';
import { ReceiveDeliveryModal } from './ReceiveDeliveryModal';
import { ChevronDown, Clock, X } from 'lucide-react';

const movementTypeBadge: Record<string, string> = {
  IN: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  OUT: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  TRANSFER: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  WASTE: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  ADJUSTMENT: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  RETURN: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
};

const CATEGORY_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; borderColor: string }
> = {
  FEED: {
    label: 'Feed',
    color: colors.warning[500],
    bgColor: 'bg-warning-50 dark:bg-warning-900/20',
    borderColor: 'border-warning-200 dark:border-warning-800',
  },
  feed: {
    label: 'Feed',
    color: colors.warning[500],
    bgColor: 'bg-warning-50 dark:bg-warning-900/20',
    borderColor: 'border-warning-200 dark:border-warning-800',
  },
  CHEMICAL: {
    label: 'Chemical',
    color: colors.info[500],
    bgColor: 'bg-info-50 dark:bg-info-900/20',
    borderColor: 'border-info-200 dark:border-info-800',
  },
  chemical: {
    label: 'Chemical',
    color: colors.info[500],
    bgColor: 'bg-info-50 dark:bg-info-900/20',
    borderColor: 'border-info-200 dark:border-info-800',
  },
  CONSUMABLE: {
    label: 'Consumable',
    color: colors.success[500],
    bgColor: 'bg-success-50 dark:bg-success-900/20',
    borderColor: 'border-success-200 dark:border-success-800',
  },
  consumable: {
    label: 'Consumable',
    color: colors.success[500],
    bgColor: 'bg-success-50 dark:bg-success-900/20',
    borderColor: 'border-success-200 dark:border-success-800',
  },
  HEALTHCARE: {
    label: 'Healthcare',
    color: colors.primary[700],
    bgColor: 'bg-accent-50 dark:bg-accent-900/20',
    borderColor: 'border-accent-200 dark:border-accent-800',
  },
  healthcare: {
    label: 'Healthcare',
    color: colors.primary[700],
    bgColor: 'bg-accent-50 dark:bg-accent-900/20',
    borderColor: 'border-accent-200 dark:border-accent-800',
  },
};

export const OverviewTab: React.FC = () => {
  const { data: overview, isLoading: overviewLoading } = useStorageOverview();
  const { data: movementsData } = useStockMovements();
  const { data: locations } = useStorageLocationList();
  const { data: pendingDeliveries } = usePendingDeliveries();
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrder | null>(null);

  // Category filter toggles
  const [visibleCategories, setVisibleCategories] = useState<Set<string>>(
    new Set(['FEED', 'CHEMICAL', 'CONSUMABLE', 'HEALTHCARE']),
  );

  // Storage location filter
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [locationDropdownOpen, setLocationDropdownOpen] = useState(false);
  const locationDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(locationDropdownRef, () => setLocationDropdownOpen(false), locationDropdownOpen);

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
    drillDownItemType,
  );

  const recentMovements = (movementsData?.items || []).slice(0, 5);

  // Filtered category data for the donut chart
  const categoryChartData = useMemo((): PieDataItem[] => {
    const totals = overview?.categoryTotals || [];
    return totals
      .filter((cat) => visibleCategories.has(cat.category.toUpperCase()))
      .map((cat) => ({
        label: CATEGORY_CONFIG[cat.category]?.label || cat.category,
        value: cat.totalQuantity,
        color: CATEGORY_CONFIG[cat.category]?.color || colors.gray[400],
      }));
  }, [overview?.categoryTotals, visibleCategories]);

  // Category value chart data
  const categoryValueChartData = useMemo((): PieDataItem[] => {
    const totals = overview?.categoryTotals || [];
    return totals
      .filter((cat) => visibleCategories.has(cat.category.toUpperCase()))
      .map((cat) => ({
        label: CATEGORY_CONFIG[cat.category]?.label || cat.category,
        value: parseMoney(cat.totalValueDecimal),
        color: CATEGORY_CONFIG[cat.category]?.color || colors.gray[400],
      }));
  }, [overview?.categoryTotals, visibleCategories]);

  // Location fill rate chart data (filtered by selected locations)
  const locationChartData = useMemo((): PieDataItem[] => {
    const rates = overview?.locationFillRates || [];
    const filtered =
      selectedLocationIds.size > 0
        ? rates.filter((loc) => selectedLocationIds.has(loc.locationId))
        : rates;
    return filtered.map((loc) => ({
      label: loc.locationName,
      value: loc.usedCapacity,
      color:
        loc.fillPercentage > 90
          ? colors.error[500]
          : loc.fillPercentage > 70
            ? colors.warning[500]
            : colors.info[500],
    }));
  }, [overview?.locationFillRates, selectedLocationIds]);

  const toggleCategory = (cat: string) => {
    setVisibleCategories((prev) => {
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
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (overviewLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  type ItemRow = NonNullable<typeof drillDownItems>[number];
  const itemRowColumns: DataTableColumn<ItemRow>[] = [
    {
      key: 'item',
      header: 'Item',
      render: (_value, item) => item.itemName || '-',
    },
    {
      key: 'location',
      header: 'Location',
      render: (_value, item) => item.locationName || '-',
    },
    {
      key: 'lot',
      header: 'Lot',
      render: (_value, item) => item.lotNumber || '-',
    },
    {
      key: 'quantity',
      header: 'Quantity',
      render: (_value, item) => (
        <>
          {item.quantity} {item.unit}
        </>
      ),
    },
    {
      key: 'expiry',
      header: 'Expiry',
      render: (_value, item) =>
        item.expiryDate ? new Date(item.expiryDate).toLocaleDateString('nb-NO') : '-',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Total Stock Value
          </div>
          <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(parseMoney(overview?.totalStockValueDecimal), DEFAULT_CURRENCY)}
          </div>
          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {overview?.totalItems || 0} items
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Low Stock Alerts
          </div>
          <div className="mt-1 text-2xl font-bold text-error-600 dark:text-error-400">
            {overview?.lowStockAlertCount || 0}
          </div>
          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Items below minimum threshold
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Recent Movements
          </div>
          <div className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {overview?.recentMovementsCount || 0}
          </div>
          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">Last 7 days</div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Storage Locations
          </div>
          <div className="mt-1 text-2xl font-bold text-info-600 dark:text-info-400">
            {overview?.locationFillRates?.length || 0}
          </div>
          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">Active locations</div>
        </div>
      </div>

      {/* Pending Deliveries Alert Banner */}
      {(pendingDeliveries || []).length > 0 && (
        <div className="bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-warning-100 dark:bg-warning-900/40 rounded-full flex items-center justify-center">
                <Clock
                  className="w-5 h-5 text-warning-600 dark:text-warning-400"
                  aria-hidden="true"
                />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-warning-800 dark:text-warning-200">
                  {pendingDeliveries!.length} delivery{' '}
                  {pendingDeliveries!.length === 1 ? 'is' : 'deliveries are'} expected today or
                  overdue
                </h4>
                <div className="mt-1 flex flex-wrap gap-2">
                  {pendingDeliveries!.slice(0, 3).map((po) => (
                    <Button
                      variant="secondary"
                      size="xs"
                      key={po.id}
                      onClick={() => setReceiveTarget(po)}
                    >
                      {po.orderNumber} - {po.supplierName}
                      <span className="text-warning-500">Mark Received</span>
                    </Button>
                  ))}
                  {pendingDeliveries!.length > 3 && (
                    <span className="text-xs text-warning-600 dark:text-warning-400 py-1">
                      +{pendingDeliveries!.length - 3} more
                    </span>
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
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Stock Distribution by Category
            </h3>
          </div>

          {/* Category filter checkboxes */}
          <div className="flex gap-3 mb-4">
            {(['FEED', 'CHEMICAL', 'CONSUMABLE', 'HEALTHCARE'] as const).map((cat) => (
              <label
                key={cat}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer border transition-all ${
                  visibleCategories.has(cat)
                    ? `${CATEGORY_CONFIG[cat].bgColor} ${CATEGORY_CONFIG[cat].borderColor}`
                    : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500'
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
                  style={{
                    backgroundColor: visibleCategories.has(cat)
                      ? CATEGORY_CONFIG[cat].color
                      : colors.neutral[300],
                  }}
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
            <div className="flex items-center justify-center py-12 text-sm text-gray-500 dark:text-gray-400">
              No inventory data available
            </div>
          )}

          {/* Click hint */}
          {categoryChartData.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 justify-center">
              {(overview?.categoryTotals || [])
                .filter((cat) => visibleCategories.has(cat.category.toUpperCase()))
                .map((cat) => (
                  <ToggleButton
                    key={cat.category}
                    onClick={() =>
                      setDrillDownCategory(drillDownCategory === cat.category ? null : cat.category)
                    }
                    pressed={drillDownCategory === cat.category}
                    className="text-xs px-3 py-1 rounded-full border transition-all"
                    pressedClassName="bg-gray-900 text-white border-gray-900"
                    idleClassName="border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    {CATEGORY_CONFIG[cat.category]?.label || cat.category}: {cat.itemCount} items
                  </ToggleButton>
                ))}
            </div>
          )}
        </div>

        {/* Stock Value by Category - Donut Chart */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Stock Value by Category
            </h3>
          </div>

          {categoryValueChartData.length > 0 && categoryValueChartData.some((d) => d.value > 0) ? (
            <div className="flex justify-center mt-9">
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
            <div className="flex items-center justify-center py-12 text-sm text-gray-500 dark:text-gray-400">
              No value data available
            </div>
          )}
        </div>
      </div>

      {/* Drill-down panel */}
      {drillDownCategory && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {CATEGORY_CONFIG[drillDownCategory]?.label || drillDownCategory} Inventory Details
            </h3>
            <Button variant="ghost" onClick={() => setDrillDownCategory(null)}>
              <X className="w-5 h-5" aria-hidden="true" />
            </Button>
          </div>
          {drillDownLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <DataTable<ItemRow>
                data={drillDownItems ?? []}
                columns={itemRowColumns}
                keyExtractor={(item) => item.id}
                emptyMessage="No items in this category."
                searchable={false}
                sortable={false}
                stickyHeader={false}
              />
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Low Stock Alerts */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Low Stock Alerts
            </h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {(overview?.lowStockAlerts || []).length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                No low stock alerts
              </div>
            ) : (
              overview?.lowStockAlerts.map((alert, idx) => (
                <div
                  key={`${alert.itemId}-${idx}`}
                  className="px-5 py-3 flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {alert.itemName}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{alert.itemType}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm">
                      <span
                        className={
                          alert.currentQuantity === 0
                            ? 'text-error-600 dark:text-error-400 font-semibold'
                            : 'text-warning-600 dark:text-warning-400 font-medium'
                        }
                      >
                        {alert.currentQuantity}
                      </span>
                      <span className="text-gray-400 dark:text-gray-500">
                        {' '}
                        / {alert.minStock} {alert.unit}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Movements */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Recent Movements
            </h3>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {recentMovements.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                No recent movements
              </div>
            ) : (
              recentMovements.map((m) => (
                <div key={m.id} className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${movementTypeBadge[m.movementType] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {m.movementType}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {m.itemName}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {m.performedBy}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {m.movementType === 'OUT' || m.movementType === 'WASTE' ? '-' : '+'}
                      {m.quantity} {m.unit}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(m.performedAt).toLocaleDateString('nb-NO', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
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
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Location Fill Rates
            </h3>

            {/* Location filter dropdown */}
            {(locations?.items || []).length > 0 && (
              <div className="relative" ref={locationDropdownRef}>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => setLocationDropdownOpen(!locationDropdownOpen)}
                >
                  {selectedLocationIds.size > 0
                    ? `${selectedLocationIds.size} selected`
                    : 'All locations'}
                  <ChevronDown
                    className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500"
                    aria-hidden="true"
                  />
                </Button>
                {locationDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg py-1 min-w-[200px] max-h-60 overflow-y-auto">
                    {selectedLocationIds.size > 0 && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setSelectedLocationIds(new Set());
                          setLocationDropdownOpen(false);
                        }}
                      >
                        Clear selection
                      </Button>
                    )}
                    {(locations?.items || []).map((loc: any) => (
                      <label
                        key={loc.id}
                        className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedLocationIds.has(loc.id)}
                          onChange={() => toggleLocation(loc.id)}
                          className="rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
                        />
                        <span className="text-xs text-gray-700 dark:text-gray-300">{loc.name}</span>
                      </label>
                    ))}
                  </div>
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
                ? overview?.locationFillRates.filter((loc) =>
                    selectedLocationIds.has(loc.locationId),
                  )
                : overview?.locationFillRates
              )?.map((loc) => (
                <div key={loc.locationId} className="flex items-center gap-4">
                  <div className="w-32 text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {loc.locationName}
                  </div>
                  <div className="flex-1">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all duration-500 ${loc.fillPercentage > 90 ? 'bg-error-500' : loc.fillPercentage > 70 ? 'bg-warning-500' : 'bg-info-500'}`}
                        style={{ width: `${Math.min(loc.fillPercentage, 100)}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-20 text-right text-xs text-gray-500 dark:text-gray-400">
                    {loc.usedCapacity} / {loc.capacity || 0}
                  </div>
                  <div className="w-10 text-right text-xs font-medium text-gray-700 dark:text-gray-300">
                    {Math.round(loc.fillPercentage)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <ReceiveDeliveryModal
        isOpen={!!receiveTarget}
        onClose={() => setReceiveTarget(null)}
        purchaseOrder={receiveTarget}
      />
    </div>
  );
};

export default OverviewTab;
