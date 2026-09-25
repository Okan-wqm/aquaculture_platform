/**
 * Storage & Stock Management Page
 * 8-tab page for warehouse, inventory, and procurement management
 */
import { PageHeader, parseMoney, ToggleButton } from '@aquaculture/shared-ui';
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStorageOverview } from '../../hooks/useStorageInventory';

// Tab Components
import { OverviewTab } from './components/OverviewTab';
import { FeedStockTab } from './components/FeedStockTab';
import { ChemicalsStockTab } from './components/ChemicalsStockTab';
import { ConsumablesStockTab } from './components/ConsumablesStockTab';
import { StorageLocationsTab } from './components/StorageLocationsTab';
import { StockMovementsTab } from './components/StockMovementsTab';
import { HealthcareStockTab } from './components/HealthcareStockTab';
import { PurchaseOrdersTab } from './components/PurchaseOrdersTab';
import { InventoryCountTab } from './components/InventoryCountTab';
import {
  Archive,
  ArrowUpDown,
  Box,
  Clipboard,
  DollarSign,
  FileText,
  FlaskConical,
  Heart,
  LayoutGrid,
  MapPin,
  ShoppingCart,
  TriangleAlert,
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

type TabId =
  | 'overview'
  | 'feed-stock'
  | 'chemicals'
  | 'consumables'
  | 'healthcare'
  | 'locations'
  | 'movements'
  | 'purchase-orders'
  | 'inventory-count';

interface Tab {
  id: TabId;
  name: string;
  icon: React.ReactNode;
}

// ============================================================================
// TABS CONFIG
// ============================================================================

const tabs: Tab[] = [
  {
    id: 'overview',
    name: 'Overview',
    icon: <LayoutGrid className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'feed-stock',
    name: 'Feed Stock',
    icon: <Box className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'chemicals',
    name: 'Chemicals',
    icon: <FlaskConical className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'consumables',
    name: 'Consumables',
    icon: <Archive className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'healthcare',
    name: 'Healthcare',
    icon: <Heart className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'locations',
    name: 'Locations',
    icon: <MapPin className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'movements',
    name: 'Movements',
    icon: <ArrowUpDown className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'purchase-orders',
    name: 'Purchase Orders',
    icon: <FileText className="w-4 h-4" aria-hidden="true" />,
  },
  {
    id: 'inventory-count',
    name: 'Inventory Count',
    icon: <Clipboard className="w-4 h-4" aria-hidden="true" />,
  },
];

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat('nb-NO', { style: 'currency', currency }).format(amount);

// ============================================================================
// COMPONENT
// ============================================================================

const StoragePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as TabId) || 'overview';

  // BUG-5 FIX: Use real data from GraphQL instead of mock imports
  const { data: overview, isLoading: overviewLoading } = useStorageOverview();

  const handleTabChange = (tabId: TabId) => {
    setSearchParams({ tab: tabId });
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab />;
      case 'feed-stock':
        return <FeedStockTab />;
      case 'chemicals':
        return <ChemicalsStockTab />;
      case 'consumables':
        return <ConsumablesStockTab />;
      case 'healthcare':
        return <HealthcareStockTab />;
      case 'locations':
        return <StorageLocationsTab />;
      case 'movements':
        return <StockMovementsTab />;
      case 'purchase-orders':
        return <PurchaseOrdersTab />;
      case 'inventory-count':
        return <InventoryCountTab />;
      default:
        return <OverviewTab />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-800">
      {/* Header */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <PageHeader
          title="Storage & Stock Management"
          description="Manage warehouses, inventory, stock movements and procurement"
          className="px-4 sm:px-6 py-6"
        />
      </div>

      {/* Summary Cards */}
      <div className="px-4 sm:px-6 py-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex items-center gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-info-100 dark:bg-info-900/40 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-info-600 dark:text-info-400" aria-hidden="true" />
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Total Stock Value</div>
              <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {overviewLoading
                  ? '...'
                  : formatCurrency(parseMoney(overview?.totalStockValueDecimal), 'NOK')}
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex items-center gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-error-100 dark:bg-error-900/40 flex items-center justify-center">
              <TriangleAlert
                className="w-5 h-5 text-error-600 dark:text-error-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Low Stock Alerts</div>
              <div className="text-lg font-bold text-error-600 dark:text-error-400">
                {overviewLoading ? '...' : (overview?.lowStockAlertCount ?? 0)}
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex items-center gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-warning-100 dark:bg-warning-900/40 flex items-center justify-center">
              <ShoppingCart
                className="w-5 h-5 text-warning-600 dark:text-warning-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Total Items</div>
              <div className="text-lg font-bold text-warning-600 dark:text-warning-400">
                {overviewLoading ? '...' : (overview?.totalItems ?? 0)}
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex items-center gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-success-100 dark:bg-success-900/40 flex items-center justify-center">
              <ArrowUpDown
                className="w-5 h-5 text-success-600 dark:text-success-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Recent Movements</div>
              <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {overviewLoading ? '...' : (overview?.recentMovementsCount ?? 0)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6">
          <nav className="-mb-px flex space-x-1 overflow-x-auto" aria-label="Tabs">
            {tabs.map((tab) => (
              <ToggleButton
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                pressed={activeTab === tab.id}
                className="inline-flex items-center gap-2 py-3 px-4 border-b-2 font-medium text-sm whitespace-nowrap transition-colors"
                pressedClassName="border-info-500 text-info-600 dark:text-info-400"
                idleClassName="border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500"
              >
                <span
                  className={
                    activeTab === tab.id ? 'text-info-500' : 'text-gray-400 dark:text-gray-500'
                  }
                >
                  {tab.icon}
                </span>
                {tab.name}
              </ToggleButton>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 sm:px-6 py-6">{renderTab()}</div>
    </div>
  );
};

export default StoragePage;
