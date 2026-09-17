/**
 * Storage & Stock Management Page
 * 8-tab page for warehouse, inventory, and procurement management
 */
import { parseMoney } from '@aquaculture/shared-ui';
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

// ============================================================================
// TYPES
// ============================================================================

type TabId = 'overview' | 'feed-stock' | 'chemicals' | 'consumables' | 'healthcare' | 'locations' | 'movements' | 'purchase-orders' | 'inventory-count';

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
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    id: 'feed-stock',
    name: 'Feed Stock',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
  },
  {
    id: 'chemicals',
    name: 'Chemicals',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
      </svg>
    ),
  },
  {
    id: 'consumables',
    name: 'Consumables',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
      </svg>
    ),
  },
  {
    id: 'healthcare',
    name: 'Healthcare',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
  },
  {
    id: 'locations',
    name: 'Locations',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'movements',
    name: 'Movements',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    ),
  },
  {
    id: 'purchase-orders',
    name: 'Purchase Orders',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'inventory-count',
    name: 'Inventory Count',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
];

// UI language is English (platform directive): dates/numbers use en-GB while
// currency stays NOK (Norwegian market).
const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * DATA SOURCES (all real backend — no mocked data on this page):
 * - useStorageOverview → farm-service storage overview (BUG-5 replaced old
 *   mock imports); per-tab hooks (inventory/locations/movements/POs/counts)
 *   and every mutation are real farm-service GraphQL.
 * SUDERRA restyle — shell only; tab bodies themed via the `.sd-f2` compat
 * layer (page-family scoped to avoid colliding with intentional category
 * colors on already-ported setup/tanks pages).
 */
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
      case 'overview': return <OverviewTab />;
      case 'feed-stock': return <FeedStockTab />;
      case 'chemicals': return <ChemicalsStockTab />;
      case 'consumables': return <ConsumablesStockTab />;
      case 'healthcare': return <HealthcareStockTab />;
      case 'locations': return <StorageLocationsTab />;
      case 'movements': return <StockMovementsTab />;
      case 'purchase-orders': return <PurchaseOrdersTab />;
      case 'inventory-count': return <InventoryCountTab />;
      default: return <OverviewTab />;
    }
  };

  return (
    <div className="sd-page sd-f2">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Environment</span>
        <h1 className="sd-page-title">Storage &amp; Stock Management</h1>
        <span className="sd-page-sub">Manage warehouses, inventory, stock movements and procurement</span>
      </div>

      {/* Summary stat cards — SUDERRA serif values (see header for sources) */}
      <div className="sd-stat-grid">
        <div className="sd-card sd-card--dash sd-stat-card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <span className="sd-stat-title">Total Stock Value</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#0b4f60" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <span className="sd-stat-value" style={{ fontSize: 24 }}>
              {overviewLoading ? '…' : formatCurrency(parseMoney(overview?.totalStockValueDecimal), 'NOK')}
            </span>
          </div>
          <div className="sd-stat-change"><span className="sd-dot sd-dot--cyan" />Live inventory valuation</div>
        </div>
        <div className={`sd-card sd-card--dash sd-stat-card${(overview?.lowStockAlertCount ?? 0) > 0 ? ' sd-stat-card--danger' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <span className="sd-stat-title">Low Stock Alerts</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#b04a28" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <div>
            <span className="sd-stat-value" style={{ fontSize: 24 }}>
              {overviewLoading ? '…' : (overview?.lowStockAlertCount ?? 0)}
            </span>
          </div>
          <div className="sd-stat-change">
            <span className={`sd-dot ${(overview?.lowStockAlertCount ?? 0) > 0 ? 'sd-dot--red' : 'sd-dot--mint'}`} />
            {(overview?.lowStockAlertCount ?? 0) > 0 ? 'Action required' : 'All good'}
          </div>
        </div>
        <div className="sd-card sd-card--dash sd-stat-card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <span className="sd-stat-title">Total Items</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#92610a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
            </svg>
          </div>
          <div>
            <span className="sd-stat-value" style={{ fontSize: 24 }}>
              {overviewLoading ? '…' : (overview?.totalItems ?? 0)}
            </span>
          </div>
          <div className="sd-stat-change"><span className="sd-dot sd-dot--amber" />Tracked inventory items</div>
        </div>
        <div className="sd-card sd-card--dash sd-stat-card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <span className="sd-stat-title">Recent Movements</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#166f5a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </div>
          <div>
            <span className="sd-stat-value" style={{ fontSize: 24 }}>
              {overviewLoading ? '…' : (overview?.recentMovementsCount ?? 0)}
            </span>
          </div>
          <div className="sd-stat-change"><span className="sd-dot sd-dot--mint" />Latest stock movements</div>
        </div>
      </div>

      {/* Tab Navigation — SUDERRA underline tabs ('Locations' label is
          load-bearing: StoragePage.spec matches /Locations|Depolar/i) */}
      <nav className="sd-tabs" aria-label="Tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            {tab.name}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div>
        {renderTab()}
      </div>
    </div>
  );
};

export default StoragePage;
