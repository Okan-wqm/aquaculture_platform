/**
 * Maintenance Page
 *
 * Tabbed shell for the maintenance feature: work orders, maintenance
 * schedules and spare parts. The three pages existed complete but were
 * never routed (FARM-MEDIUM-113); this shell wires them into
 * /sites/maintenance following the module's searchParams-tab convention
 * (same pattern as StoragePage).
 *
 * SUDERRA restyle — shell provides pagehead + underline tabs; the child
 * pages keep their own headers/toolbars (themed via the `.sd-f2` compat
 * layer). Tab names/ids are load-bearing: MaintenancePage.spec asserts the
 * exact English names and the ?tab=spare-parts deep link.
 *
 * DATA SOURCES: all child pages use real farm-service GraphQL (work
 * orders / schedules / spare parts + their mutations) — no mocked data.
 * UI language: English (platform directive, hardcoded strings).
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { WorkOrdersPage } from './WorkOrdersPage';
import { MaintenanceSchedulesPage } from './MaintenanceSchedulesPage';
import { SparePartsPage } from './SparePartsPage';

type TabId = 'work-orders' | 'schedules' | 'spare-parts';

const TABS: { id: TabId; name: string }[] = [
  { id: 'work-orders', name: 'Work Orders' },
  { id: 'schedules', name: 'Maintenance Schedules' },
  { id: 'spare-parts', name: 'Spare Parts' },
];

const MaintenancePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = TABS.some((t) => t.id === requestedTab)
    ? (requestedTab as TabId)
    : 'work-orders';

  const handleTabChange = (tabId: TabId) => {
    setSearchParams({ tab: tabId });
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'schedules':
        return <MaintenanceSchedulesPage />;
      case 'spare-parts':
        return <SparePartsPage />;
      case 'work-orders':
      default:
        return <WorkOrdersPage />;
    }
  };

  return (
    <div className="sd-page sd-f2">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Environment</span>
        <h1 className="sd-page-title">Maintenance</h1>
        <span className="sd-page-sub">Work orders, preventive schedules and spare parts</span>
      </div>

      <nav className="sd-tabs" aria-label="Maintenance tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.name}
          </button>
        ))}
      </nav>
      {renderTab()}
    </div>
  );
};

export { MaintenancePage };
export default MaintenancePage;
