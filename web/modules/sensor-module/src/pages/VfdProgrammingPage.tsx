/**
 * VFD Programming Page
 *
 * Main page for VFD remote programming with 4 tabs:
 * Parameters, Change Sets, Automation, Audit Log.
 *
 * Includes device selector, draft bar, and create change set dialog.
 */

import React, { useEffect, useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Settings,
  HelpCircle,
  Cpu,
  FileText,
  Zap,
  History,
  ChevronDown,
} from 'lucide-react';
import { useVfdProgrammingStore } from '../store/vfdProgrammingStore';
import { useVfdParameterDefinitions } from '../hooks/useVfdParameterDefinitions';
import { useVfdChangeSets } from '../hooks/useVfdChangeSets';
import { useVfdAuditLog } from '../hooks/useVfdAuditLog';
import { useVfdAutomationRules } from '../hooks/useVfdAutomationRules';
import { VfdParameterBrowser } from '../components/vfd/VfdParameterBrowser';
import { VfdChangeSetList } from '../components/vfd/VfdChangeSetList';
import { VfdAutomationRuleList } from '../components/vfd/VfdAutomationRuleList';
import { VfdAuditLogViewer } from '../components/vfd/VfdAuditLogViewer';
import { VfdDraftBar } from '../components/vfd/VfdDraftBar';
import { VfdCreateChangeSetDialog } from '../components/vfd/VfdCreateChangeSetDialog';

// ============================================================================
// Mock device list (will be replaced by real data from device hooks)
// ============================================================================

const MOCK_DEVICES = [
  { id: 'vfd-1', name: 'Pump VFD #1 — Danfoss FC302' },
  { id: 'vfd-2', name: 'Pump VFD #2 — ABB ACS580' },
  { id: 'vfd-3', name: 'Aerator VFD — Siemens G120' },
];

// ============================================================================
// Tab definitions
// ============================================================================

type TabId = 'parameters' | 'changesets' | 'automation' | 'audit';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'parameters', label: 'Parameters', icon: <Cpu className="h-4 w-4" /> },
  { id: 'changesets', label: 'Change Sets', icon: <FileText className="h-4 w-4" /> },
  { id: 'automation', label: 'Automation', icon: <Zap className="h-4 w-4" /> },
  { id: 'audit', label: 'Audit Log', icon: <History className="h-4 w-4" /> },
];

// ============================================================================
// Component
// ============================================================================

export function VfdProgrammingPage() {
  const { deviceId: routeDeviceId } = useParams<{ deviceId?: string }>();
  const {
    selectedVfdDeviceId,
    setSelectedDevice,
    activeTab,
    setActiveTab,
  } = useVfdProgrammingStore();

  // Sync route param to store
  useEffect(() => {
    if (routeDeviceId && routeDeviceId !== selectedVfdDeviceId) {
      setSelectedDevice(routeDeviceId);
    } else if (!selectedVfdDeviceId && MOCK_DEVICES.length > 0) {
      setSelectedDevice(MOCK_DEVICES[0].id);
    }
  }, [routeDeviceId, selectedVfdDeviceId, setSelectedDevice]);

  // Hooks — parameter definitions
  const paramHook = useVfdParameterDefinitions(selectedVfdDeviceId ?? undefined);

  // Hooks — change sets
  const changeSetHook = useVfdChangeSets();
  useEffect(() => {
    if (selectedVfdDeviceId) {
      changeSetHook.fetchChangeSets(selectedVfdDeviceId);
    }
     
  }, [selectedVfdDeviceId]);

  // Hooks — audit log
  const auditHook = useVfdAuditLog();
  const [auditParamFilter, setAuditParamFilter] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (selectedVfdDeviceId) {
      auditHook.fetchLogs(selectedVfdDeviceId, auditParamFilter);
    }
     
  }, [selectedVfdDeviceId, auditParamFilter]);

  // Hooks — automation rules
  const automationHook = useVfdAutomationRules();
  useEffect(() => {
    if (selectedVfdDeviceId) {
      automationHook.fetchRules(selectedVfdDeviceId);
    }
     
  }, [selectedVfdDeviceId]);

  // Available parameter names for audit filter
  const availableParams = useMemo(() => {
    return paramHook.definitions.map((d) => d.parameterName);
  }, [paramHook.definitions]);

  // Create change set handler
  const handleCreateChangeSet = useCallback(
    async (data: {
      description: string;
      scheduledAt: string | null;
      items: Array<{ parameterName: string; requestedValue: number }>;
    }) => {
      if (!selectedVfdDeviceId) return;
      await changeSetHook.createChangeSet({
        vfdDeviceId: selectedVfdDeviceId,
        description: data.description,
        scheduledAt: data.scheduledAt,
        items: data.items.map((item) => ({
          parameterDefinitionId: '', // Will be resolved by backend
          parameterName: item.parameterName,
          requestedValue: item.requestedValue,
        })),
      });
    },
    [selectedVfdDeviceId, changeSetHook],
  );

  return (
    <div className="flex min-h-full flex-col" data-testid="vfd-programming-page">
      {/* Header */}
      <header className="border-b bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-indigo-600" />
            <h1 className="text-lg font-semibold text-gray-900">VFD Programming</h1>
            <span className="text-gray-300">|</span>
            {/* Device Selector */}
            <div className="relative">
              <select
                value={selectedVfdDeviceId ?? ''}
                onChange={(e) => setSelectedDevice(e.target.value)}
                className="appearance-none rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm font-medium text-gray-700 focus:border-indigo-500 focus:ring-indigo-500"
                aria-label="Select VFD device"
                data-testid="device-selector"
              >
                {MOCK_DEVICES.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Help"
          >
            <HelpCircle className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <nav className="mt-3 flex gap-1" role="tablist" aria-label="VFD Programming tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`tabpanel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-t-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 border-indigo-600 text-indigo-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Tab content */}
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        {activeTab === 'parameters' && (
          <div role="tabpanel" id="tabpanel-parameters" aria-labelledby="tab-parameters">
            <VfdParameterBrowser
              definitions={paramHook.definitions}
              loading={paramHook.loading}
              error={paramHook.error}
            />
          </div>
        )}

        {activeTab === 'changesets' && (
          <div role="tabpanel" id="tabpanel-changesets" aria-labelledby="tab-changesets">
            <VfdChangeSetList
              changeSets={changeSetHook.changeSets}
              loading={changeSetHook.loading}
              error={changeSetHook.error}
              hasMore={changeSetHook.pagination.hasMore}
              onLoadMore={changeSetHook.loadMore}
              onApprove={changeSetHook.approveChangeSet}
              onReject={changeSetHook.rejectChangeSet}
              onApply={changeSetHook.applyChangeSet}
              onRollback={changeSetHook.rollbackChangeSet}
              onCancel={changeSetHook.cancelChangeSet}
              onSubmitForApproval={changeSetHook.submitForApproval}
            />
          </div>
        )}

        {activeTab === 'automation' && (
          <div role="tabpanel" id="tabpanel-automation" aria-labelledby="tab-automation">
            <VfdAutomationRuleList
              rules={automationHook.rules}
              loading={automationHook.loading}
              error={automationHook.error}
              onToggle={automationHook.toggleRule}
              onDelete={automationHook.deleteRule}
              onCreate={automationHook.createRule as unknown as (input: Record<string, unknown>) => Promise<unknown>}
              onUpdate={automationHook.updateRule as (id: string, input: Record<string, unknown>) => Promise<unknown>}
            />
          </div>
        )}

        {activeTab === 'audit' && (
          <div role="tabpanel" id="tabpanel-audit" aria-labelledby="tab-audit">
            <VfdAuditLogViewer
              logs={auditHook.logs}
              loading={auditHook.loading}
              error={auditHook.error}
              hasMore={auditHook.pagination.hasMore}
              onLoadMore={auditHook.loadMore}
              availableParameters={availableParams}
              onParameterFilter={setAuditParamFilter}
            />
          </div>
        )}
      </main>

      {/* Draft bar */}
      <VfdDraftBar />

      {/* Create change set dialog */}
      <VfdCreateChangeSetDialog onSubmit={handleCreateChangeSet} />
    </div>
  );
}

export default VfdProgrammingPage;
