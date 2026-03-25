/**
 * SCADA Builder Properties Panel — 2-tier tab navigation
 *
 * Renders:
 *  1. A pill-toggle group selector ("Widget" vs "Package")
 *  2. Context-sensitive tab bar for the active group
 *
 * Widget-scoped tabs: Properties | Events | Animations
 * Package-scoped tabs: Alarms | Control | Trends | Auto | Scripts
 */

import React from 'react';
import {
  Settings,
  Zap,
  Play,
  Bell,
  Shield,
  TrendingUp,
  Cpu,
  Code,
  GitBranch,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types (exported for PropertiesPanel)
// ---------------------------------------------------------------------------

export type TabGroup = 'widget-scoped' | 'package-scoped';
export type WidgetScopedTabId = 'properties' | 'events' | 'animations';
export type PackageScopedTabId = 'alarms' | 'control' | 'trends' | 'automation' | 'scripts';
export type TabId = WidgetScopedTabId | PackageScopedTabId;

interface TabDef {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const WIDGET_SCOPED_TABS: TabDef[] = [
  { id: 'properties', label: 'Properties', icon: Settings },
  { id: 'events', label: 'Events', icon: Zap },
  { id: 'animations', label: 'Animations', icon: Play },
];

export const PACKAGE_SCOPED_TABS: TabDef[] = [
  { id: 'alarms', label: 'Alarms', icon: Bell },
  { id: 'control', label: 'Control', icon: Shield },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'automation', label: 'Auto', icon: Cpu },
  { id: 'scripts', label: 'Scripts', icon: Code },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWidgetScopedTab(id: TabId): id is WidgetScopedTabId {
  return id === 'properties' || id === 'events' || id === 'animations';
}

export function groupForTab(id: TabId): TabGroup {
  return isWidgetScopedTab(id) ? 'widget-scoped' : 'package-scoped';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PropertiesTabNavProps {
  activeGroup: TabGroup;
  activeTab: TabId;
  onGroupChange: (group: TabGroup) => void;
  onTabChange: (tab: TabId) => void;
  /** True when a widget is selected on canvas. */
  hasWidgetSelected: boolean;
  /** True when an edge is selected on canvas. */
  hasEdgeSelected: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PropertiesTabNav: React.FC<PropertiesTabNavProps> = ({
  activeGroup,
  activeTab,
  onGroupChange,
  onTabChange,
  hasWidgetSelected,
  hasEdgeSelected,
}) => {
  const tabs = activeGroup === 'widget-scoped' ? WIDGET_SCOPED_TABS : PACKAGE_SCOPED_TABS;

  const isTabDisabled = (tab: TabDef): boolean => {
    // For edges: Events and Animations tabs are disabled
    if (hasEdgeSelected && (tab.id === 'events' || tab.id === 'animations')) {
      return true;
    }
    return false;
  };

  return (
    <div className="border-b border-gray-200">
      {/* Tier 1: Group pill toggle */}
      <div className="px-3 pt-3 pb-2">
        <div className="flex bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => onGroupChange('widget-scoped')}
            aria-label={hasEdgeSelected ? 'Connection properties' : 'Widget properties'}
            aria-pressed={activeGroup === 'widget-scoped'}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeGroup === 'widget-scoped'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            style={{ minHeight: '36px' }}
          >
            {hasEdgeSelected ? (
              <>
                <GitBranch className="w-3.5 h-3.5" />
                Connection
              </>
            ) : (
              <>
                <Settings className="w-3.5 h-3.5" />
                Widget
              </>
            )}
            {!hasWidgetSelected && !hasEdgeSelected && activeGroup === 'widget-scoped' && (
              <span className="ml-1 text-[11px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full">
                no selection
              </span>
            )}
          </button>
          <button
            onClick={() => onGroupChange('package-scoped')}
            aria-label="Package settings"
            aria-pressed={activeGroup === 'package-scoped'}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeGroup === 'package-scoped'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
            style={{ minHeight: '36px' }}
          >
            <Cpu className="w-3.5 h-3.5" />
            Package
          </button>
        </div>
      </div>

      {/* Tier 2: Tab bar */}
      <div className="flex px-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const disabled = isTabDisabled(tab);
          const active = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => {
                if (!disabled) onTabChange(tab.id);
              }}
              disabled={disabled}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium transition-colors ${
                disabled
                  ? 'opacity-40 cursor-not-allowed text-gray-400'
                  : active
                    ? 'text-cyan-600 border-b-2 border-cyan-500'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50 border-b-2 border-transparent'
              }`}
              style={{ minHeight: '44px' }}
              title={disabled ? `${tab.label} is not available for edges` : tab.label}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default PropertiesTabNav;
