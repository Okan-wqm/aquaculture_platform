/**
 * Maintenance Page
 *
 * Tabbed shell for the maintenance feature: work orders, maintenance
 * schedules and spare parts. The three pages existed complete but were
 * never routed (FARM-MEDIUM-113); this shell wires them into
 * /sites/maintenance following the module's searchParams-tab convention
 * (same pattern as StoragePage).
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
    <div>
      <div className="border-b border-gray-200 bg-white px-4">
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Maintenance tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              className={`
                inline-flex items-center gap-2 py-3 px-4 border-b-2 font-medium text-sm whitespace-nowrap transition-colors
                ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.name}
            </button>
          ))}
        </nav>
      </div>
      {renderTab()}
    </div>
  );
};

export { MaintenancePage };
export default MaintenancePage;
