/**
 * Farm Setup Page
 * Main setup page with tabbed navigation for Sites, Departments, Equipment, etc.
 *
 * SUDERRA restyle — page shell + tab bar only; the 12 tab components keep
 * their logic and markup untouched and are themed through the scoped
 * legacy-palette compatibility layer (`.sd-page …` rules in the shell
 * stylesheet remap gray/blue utilities to SUDERRA tokens for the host
 * document). Import/Export stay DISABLED placeholders ("Coming Soon").
 *
 * DATA SOURCES: every tab fetches real farm-service data through its own
 * hook (useSiteList, useDepartmentsBySite, useSystemsBySite,
 * useSupplierList, useFeedList, …) — no mocked data on this page.
 * MOCK/PLACEHOLDER parts: the Import and Export buttons have NO backend;
 * they render disabled with a "Coming Soon" tooltip by design.
 */
import React from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';

// Tab Components (will be imported)
import { SitesTab } from './tabs/SitesTab';
import { DepartmentsTab } from './tabs/DepartmentsTab';
import { SystemsTab } from './tabs/SystemsTab';
import { EquipmentTab } from './tabs/EquipmentTab';
import { SpeciesTab } from './tabs/SpeciesTab';
import { SuppliersTab } from './tabs/SuppliersTab';
import { SlaughterFacilitiesTab } from './tabs/SlaughterFacilitiesTab';
import { ChemicalsTab } from './tabs/ChemicalsTab';
import { ConsumablesTab } from './tabs/ConsumablesTab';
import { FishHealthChemicalsTab } from './tabs/FishHealthChemicalsTab';
import { FeedsTab } from './tabs/FeedsTab';
import { WorkersTab } from './tabs/WorkersTab';

interface SetupTab {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  description: string;
}

const setupTabs: SetupTab[] = [
  {
    id: 'sites',
    label: 'Sites',
    path: 'sites',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
        />
      </svg>
    ),
    description: 'Manage farm locations and sites',
  },
  {
    id: 'departments',
    label: 'Departments',
    path: 'departments',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
        />
      </svg>
    ),
    description: 'Configure departments within sites',
  },
  {
    id: 'systems',
    label: 'Systems',
    path: 'systems',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
        />
      </svg>
    ),
    description: 'Manage production systems (RAS, Ponds, etc.)',
  },
  {
    id: 'equipment',
    label: 'Equipment',
    path: 'equipment',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
    description: 'Manage tanks, pumps, and other equipment',
  },
  {
    id: 'species',
    label: 'Species',
    path: 'species',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"
        />
      </svg>
    ),
    description: 'Manage aquaculture species and optimal conditions',
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    path: 'suppliers',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
        />
      </svg>
    ),
    description: 'Manage equipment and feed suppliers',
  },
  {
    id: 'slaughter-facilities',
    label: 'Slaughter Facilities',
    path: 'slaughter-facilities',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
        />
      </svg>
    ),
    description: 'Slaughter facility approval numbers for regulatory reports',
  },
  {
    id: 'chemicals',
    label: 'Chemicals',
    path: 'chemicals',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
        />
      </svg>
    ),
    description: 'Configure chemicals and treatments',
  },
  {
    id: 'consumables',
    label: 'Consumables',
    path: 'consumables',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
        />
      </svg>
    ),
    description: 'Manage consumable materials and supplies',
  },
  {
    id: 'fish-health',
    label: 'Fish Health',
    path: 'fish-health',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
        />
      </svg>
    ),
    description: 'Fish health chemicals and treatments',
  },
  {
    id: 'feeds',
    label: 'Feeds',
    path: 'feeds',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
        />
      </svg>
    ),
    description: 'Manage feed types and feeding tables',
  },
  {
    id: 'workers',
    label: 'Workers',
    path: 'workers',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
        />
      </svg>
    ),
    description: 'Manage farm workers and staff',
  },
];

export const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Determine active tab from URL
  const currentPath = location.pathname.split('/').pop() || 'sites';
  const activeTab = setupTabs.find((tab) => tab.path === currentPath)?.id || 'sites';

  const handleTabChange = (tabPath: string) => {
    navigate(`/sites/setup/${tabPath}`);
  };

  return (
    <div className="sd-page">
      {/* Page header (mockup pattern: eyebrow + serif title + subtitle) */}
      <div className="sd-pagehead">
        <span className="sd-eyebrow">Setup</span>
        <h1 className="sd-page-title">Farm Setup</h1>
        <span className="sd-page-sub">Configure your farm infrastructure, equipment, and resources</span>
      </div>

      {/* Actions row — Import/Export are disabled placeholders (no backend);
          "Coming Soon" tooltips preserved */}
      <div className="sd-actions">
        {(['Import', 'Export'] as const).map((label) => (
          <div className="relative group" key={label}>
            <button type="button" disabled className="sd-btn-ghost" style={{ opacity: 0.55, cursor: 'not-allowed' }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {label === 'Import' ? (
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                ) : (
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                )}
              </svg>
              {label}
            </button>
            <span
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 text-xs font-medium rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
              style={{ color: '#fffdf8', background: '#0a1f2b' }}
            >
              Coming Soon
            </span>
          </div>
        ))}
      </div>

      {/* Tab Navigation — SUDERRA underline tabs */}
      <nav className="sd-tabs" aria-label="Tabs">
        {setupTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.path)}
            className={`sd-tab${activeTab === tab.id ? ' sd-tab--active' : ''}`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div>
        <Routes>
          <Route index element={<Navigate to="sites" replace />} />
          <Route path="sites" element={<SitesTab />} />
          <Route path="departments" element={<DepartmentsTab />} />
          <Route path="systems" element={<SystemsTab />} />
          <Route path="equipment" element={<EquipmentTab />} />
          <Route path="species" element={<SpeciesTab />} />
          <Route path="suppliers" element={<SuppliersTab />} />
          <Route path="slaughter-facilities" element={<SlaughterFacilitiesTab />} />
          <Route path="chemicals" element={<ChemicalsTab />} />
          <Route path="consumables" element={<ConsumablesTab />} />
          <Route path="fish-health" element={<FishHealthChemicalsTab />} />
          <Route path="feeds" element={<FeedsTab />} />
          <Route path="workers" element={<WorkersTab />} />
          <Route path="*" element={<Navigate to="sites" replace />} />
        </Routes>
      </div>
    </div>
  );
};

export default SetupPage;
