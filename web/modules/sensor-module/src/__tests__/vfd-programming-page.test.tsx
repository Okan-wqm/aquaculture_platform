/**
 * @vitest-environment jsdom
 */

/**
 * VFD Programming Page — Comprehensive Tests
 *
 * Tests for all VFD programming components:
 * VfdParameterBrowser, VfdChangeSetList, VfdAutomationRuleList,
 * VfdAuditLogViewer, VfdDraftBar, VfdProgrammingPage.
 *
 * Uses vitest + @testing-library/react with mocked hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

import { VfdParameterBrowser } from '../components/vfd/VfdParameterBrowser';
import { VfdChangeSetList } from '../components/vfd/VfdChangeSetList';
import { VfdAutomationRuleList } from '../components/vfd/VfdAutomationRuleList';
import { VfdAuditLogViewer } from '../components/vfd/VfdAuditLogViewer';
import { VfdDraftBar } from '../components/vfd/VfdDraftBar';
import { useVfdProgrammingStore } from '../store/vfdProgrammingStore';

import type {
  VfdParameterDefinition,
  VfdChangeSet,
  VfdAutomationRule,
  VfdParameterAuditLog,
} from '../types/vfd.types';
import {
  VfdProgrammingParameterCategory,
  VfdChangeSetStatus,
  VfdRiskLevel,
} from '../types/vfd.types';

// ============================================================================
// Test Utilities
// ============================================================================

function resetStore() {
  const { getState } = useVfdProgrammingStore;
  // Reset all state
  getState().clearDraft();
  getState().setActiveTab('parameters');
  getState().setChangeSetFilter(null);
  getState().setSelectedChangeSetId(null);
  getState().closeCreateDialog();
}

afterEach(() => {
  cleanup();
  resetStore();
});

// ============================================================================
// Mock Data Factories
// ============================================================================

function makeParam(overrides: Partial<VfdParameterDefinition> = {}): VfdParameterDefinition {
  return {
    id: 'p-1',
    tenantId: 't1',
    brand: 'Danfoss',
    modelSeries: 'FC302',
    parameterName: 'P001',
    displayName: 'Motor Rated Voltage',
    description: 'Motor rated voltage setting',
    category: VfdProgrammingParameterCategory.MOTOR,
    group: 'Motor',
    registerAddress: 1,
    registerCount: 1,
    functionCode: 3,
    dataType: 'UINT16',
    scalingFactor: 1,
    offset: 0,
    unit: 'V',
    byteOrder: 'big',
    wordOrder: 'big',
    minValue: 200,
    maxValue: 690,
    defaultValue: 400,
    step: 1,
    riskLevel: VfdRiskLevel.LOW,
    requiresMotorStop: false,
    isReadable: true,
    isWritable: false,
    isActive: true,
    displayOrder: 1,
    metadata: null,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    currentValue: 400,
    ...overrides,
  };
}

function makeWritableParam(overrides: Partial<VfdParameterDefinition> = {}): VfdParameterDefinition {
  return makeParam({
    id: 'p-2',
    parameterName: 'P003',
    displayName: 'Acceleration Time',
    description: 'Motor acceleration time',
    category: VfdProgrammingParameterCategory.SPEED,
    group: 'Speed',
    unit: 's',
    minValue: 0.1,
    maxValue: 3600,
    defaultValue: 5.0,
    step: 0.1,
    isWritable: true,
    isReadable: true,
    riskLevel: VfdRiskLevel.LOW,
    currentValue: 5.0,
    displayOrder: 3,
    ...overrides,
  });
}

function makeAdvancedParam(): VfdParameterDefinition {
  return makeParam({
    id: 'p-adv',
    parameterName: 'P009',
    displayName: 'Modbus Address',
    description: 'Modbus slave address',
    category: VfdProgrammingParameterCategory.COMMUNICATION,
    group: 'Communication',
    unit: '',
    isWritable: true,
    isReadable: true,
    displayOrder: 150, // Advanced = displayOrder > 100
    currentValue: 1,
  });
}

function makeChangeSet(overrides: Partial<VfdChangeSet> = {}): VfdChangeSet {
  return {
    id: 'cs-001',
    tenantId: 't1',
    vfdDeviceId: 'vfd-1',
    status: VfdChangeSetStatus.PENDING_APPROVAL,
    description: 'Pump Speed Optimization',
    createdBy: 'john@acme.com',
    approvedBy: null,
    rejectedBy: null,
    rejectionReason: null,
    appliedAt: null,
    verifiedAt: null,
    scheduledAt: '2026-03-28T02:00:00Z',
    automationRuleId: null,
    rollbackOfId: null,
    metadata: { riskLevel: VfdRiskLevel.MEDIUM },
    items: [
      {
        id: 'item-1', changeSetId: 'cs-001', parameterDefinitionId: 'pd-1',
        parameterName: 'P003', previousValue: 5.0, requestedValue: 8.0,
        appliedValue: null, status: '', errorMessage: null, appliedAt: null, createdAt: '2026-03-27T10:30:00Z',
      },
    ],
    createdAt: '2026-03-27T10:30:00Z',
    updatedAt: '2026-03-27T10:30:00Z',
    ...overrides,
  };
}

function makeAppliedChangeSet(): VfdChangeSet {
  return makeChangeSet({
    id: 'cs-002',
    status: VfdChangeSetStatus.APPLIED,
    description: 'Motor Protection Limits',
    appliedAt: '2026-03-26T14:00:00Z',
    metadata: { riskLevel: VfdRiskLevel.CRITICAL },
    items: [
      {
        id: 'item-4', changeSetId: 'cs-002', parameterDefinitionId: 'pd-7',
        parameterName: 'P007', previousValue: 15.0, requestedValue: 12.0,
        appliedValue: 12.0, status: 'SUCCESS', errorMessage: null, appliedAt: '2026-03-26T14:00:00Z', createdAt: '2026-03-26T09:00:00Z',
      },
    ],
  });
}

function makeRule(overrides: Partial<VfdAutomationRule> = {}): VfdAutomationRule {
  return {
    id: 'rule-1',
    tenantId: 't1',
    name: 'Night Mode Speed Reduction',
    description: 'Reduce pump speed during night hours',
    triggerCondition: { operator: 'AND', conditions: [
      { field: 'temperature', operator: '>', value: 28, unit: 'degC' },
    ]},
    targetVfdDeviceIds: ['vfd-1', 'vfd-2'],
    parameterChanges: [{ parameterName: 'P005', newValue: 35 }],
    requiresApproval: true,
    priority: 10,
    isActive: true,
    lastTriggeredAt: '2026-03-27T02:00:00Z',
    triggerCount: 47,
    createdBy: 'admin@acme.com',
    createdAt: '2026-03-01T10:00:00Z',
    updatedAt: '2026-03-27T02:00:00Z',
    ...overrides,
  };
}

function makeAuditLog(overrides: Partial<VfdParameterAuditLog> = {}): VfdParameterAuditLog {
  return {
    id: 'log-1',
    tenantId: 't1',
    vfdDeviceId: 'vfd-1',
    changeSetId: 'cs-001',
    parameterName: 'P005',
    previousValue: 50.0,
    newValue: 45.0,
    action: 'CHANGE_SET',
    performedBy: 'john@acme.com',
    clientIp: null,
    userAgent: null,
    automationRuleId: null,
    metadata: { riskLevel: VfdRiskLevel.MEDIUM },
    timestamp: '2026-03-27T10:30:22Z',
    ...overrides,
  };
}

// ============================================================================
// VfdParameterBrowser Tests
// ============================================================================

describe('VfdParameterBrowser', () => {
  const defaultParams = [
    makeParam(),
    makeWritableParam(),
    makeWritableParam({
      id: 'p-3', parameterName: 'P005', displayName: 'Maximum Frequency',
      group: 'Speed', unit: 'Hz', currentValue: 50, minValue: 0, maxValue: 599,
      riskLevel: VfdRiskLevel.MEDIUM,
    }),
    makeAdvancedParam(),
  ];

  it('renders parameter list', () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);
    expect(screen.getByTestId('vfd-parameter-browser')).toBeTruthy();
    expect(screen.getByText('P001')).toBeTruthy();
    expect(screen.getByText('P003')).toBeTruthy();
    expect(screen.getByText('P005')).toBeTruthy();
  });

  it('filters by group', async () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);

    // Check the "Motor" group checkbox
    const motorCheckbox = screen.getAllByRole('checkbox').find((el) => {
      const label = el.closest('label');
      return label?.textContent?.includes('Motor');
    }) as HTMLInputElement;
    expect(motorCheckbox).toBeTruthy();

    await userEvent.click(motorCheckbox);

    // Only Motor group params should remain (P001)
    expect(screen.getByText('P001')).toBeTruthy();
    expect(screen.queryByText('P005')).toBeNull();
  });

  it('search filters by name', async () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);
    const searchInput = screen.getByPlaceholderText('Search parameters...');
    await userEvent.type(searchInput, 'Acceleration');

    expect(screen.getByText('P003')).toBeTruthy();
    expect(screen.queryByText('P001')).toBeNull();
  });

  it('shows read-only badge for read-only params', () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);
    expect(screen.getByTestId('readonly-badge-P001')).toBeTruthy();
    expect(screen.queryByTestId('readonly-badge-P003')).toBeNull();
  });

  it('inline value input respects min/max', async () => {
    render(<VfdParameterBrowser definitions={[makeWritableParam()]} loading={false} error={null} />);
    const input = screen.getByLabelText('New value for P003') as HTMLInputElement;

    // Type value below min
    await userEvent.clear(input);
    await userEvent.type(input, '0.01');

    // Should show validation error
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('Add to Draft adds to store', async () => {
    render(<VfdParameterBrowser definitions={[makeWritableParam()]} loading={false} error={null} />);

    const input = screen.getByLabelText('New value for P003') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '10');

    const addBtn = screen.getByLabelText('Add P003 to draft');
    await userEvent.click(addBtn);

    const { draftItems } = useVfdProgrammingStore.getState();
    expect(draftItems.size).toBe(1);
    expect(draftItems.get('P003')?.newValue).toBe(10);
  });

  it('advanced toggle shows/hides advanced params', async () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);

    // Initially, advanced params hidden (displayOrder > 100)
    expect(screen.queryByText('P009')).toBeNull();

    // Toggle advanced
    const advCheckbox = screen.getAllByRole('checkbox').find((el) => {
      const label = el.closest('label');
      return label?.textContent?.includes('Advanced');
    }) as HTMLInputElement;

    await userEvent.click(advCheckbox);
    expect(screen.getByText('P009')).toBeTruthy();
  });

  it('risk level badges show correct colors', () => {
    render(<VfdParameterBrowser definitions={defaultParams} loading={false} error={null} />);

    const lowBadge = screen.getByTestId('risk-badge-P001');
    expect(lowBadge.textContent).toContain('LOW');
    expect(lowBadge.className).toContain('bg-green');

    const medBadge = screen.getByTestId('risk-badge-P005');
    expect(medBadge.textContent).toContain('MEDIUM');
    expect(medBadge.className).toContain('bg-yellow');
  });

  it('shows loading state', () => {
    render(<VfdParameterBrowser definitions={[]} loading={true} error={null} />);
    expect(screen.getByText('Loading parameters...')).toBeTruthy();
  });

  it('shows empty state when no parameters found', () => {
    render(<VfdParameterBrowser definitions={[]} loading={false} error={null} />);
    expect(screen.getByText('No parameters found')).toBeTruthy();
  });

  it('shows error state', () => {
    render(<VfdParameterBrowser definitions={[]} loading={false} error="Network error" />);
    expect(screen.getByText('Network error')).toBeTruthy();
  });
});

// ============================================================================
// VfdChangeSetList Tests
// ============================================================================

describe('VfdChangeSetList', () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  const defaultProps = {
    changeSets: [makeChangeSet(), makeAppliedChangeSet()],
    loading: false,
    error: null,
    hasMore: false,
    onLoadMore: noop,
    onApprove: noop,
    onReject: noop,
    onApply: noop,
    onRollback: noop,
    onCancel: noop,
    onSubmitForApproval: noop,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders change set cards', () => {
    render(<VfdChangeSetList {...defaultProps} />);
    expect(screen.getByTestId('changeset-card-cs-001')).toBeTruthy();
    expect(screen.getByTestId('changeset-card-cs-002')).toBeTruthy();
  });

  it('status filter works', async () => {
    render(<VfdChangeSetList {...defaultProps} />);
    const filter = screen.getByLabelText('Filter by status') as HTMLSelectElement;

    await userEvent.selectOptions(filter, VfdChangeSetStatus.APPLIED);

    // Only applied change set should be visible
    expect(screen.queryByTestId('changeset-card-cs-001')).toBeNull();
    expect(screen.getByTestId('changeset-card-cs-002')).toBeTruthy();
  });

  it('action buttons match status: approve shown for PENDING_APPROVAL', () => {
    render(<VfdChangeSetList {...defaultProps} />);
    expect(screen.getByTestId('approve-btn-cs-001')).toBeTruthy();
  });

  it('expand shows items table', async () => {
    render(<VfdChangeSetList {...defaultProps} />);

    // Click expand button on first change set
    const expandBtn = screen.getAllByLabelText('Expand items')[0];
    await userEvent.click(expandBtn);

    // Should show parameter name in expanded table
    expect(screen.getByText('P003')).toBeTruthy();
  });

  it('load more pagination', () => {
    render(<VfdChangeSetList {...defaultProps} hasMore={true} />);
    const loadMoreBtn = screen.getByText('Load More');
    expect(loadMoreBtn).toBeTruthy();
    fireEvent.click(loadMoreBtn);
    expect(noop).toHaveBeenCalled();
  });

  it('approve calls handler', async () => {
    render(<VfdChangeSetList {...defaultProps} />);
    const approveBtn = screen.getByTestId('approve-btn-cs-001');
    await userEvent.click(approveBtn);
    expect(defaultProps.onApprove).toHaveBeenCalledWith('cs-001');
  });

  it('shows empty state when no change sets', () => {
    render(<VfdChangeSetList {...defaultProps} changeSets={[]} />);
    expect(screen.getByText('No change sets yet')).toBeTruthy();
  });
});

// ============================================================================
// VfdAutomationRuleList Tests
// ============================================================================

describe('VfdAutomationRuleList', () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  const defaultProps = {
    rules: [
      makeRule(),
      makeRule({ id: 'rule-2', name: 'Emergency Stop', isActive: false, triggerCount: 3 }),
    ],
    loading: false,
    error: null,
    onToggle: noop,
    onDelete: noop,
    onCreate: noop,
    onUpdate: noop,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders rule cards', () => {
    render(<VfdAutomationRuleList {...defaultProps} />);
    expect(screen.getByTestId('rule-card-rule-1')).toBeTruthy();
    expect(screen.getByTestId('rule-card-rule-2')).toBeTruthy();
  });

  it('toggle active/inactive', async () => {
    render(<VfdAutomationRuleList {...defaultProps} />);

    // Toggle first rule (active -> inactive)
    const toggleBtn = screen.getByTestId('toggle-btn-rule-1');
    await userEvent.click(toggleBtn);
    expect(defaultProps.onToggle).toHaveBeenCalledWith('rule-1', false);
  });

  it('delete with confirmation', async () => {
    render(<VfdAutomationRuleList {...defaultProps} />);

    // Click delete
    const deleteBtn = screen.getByTestId('delete-btn-rule-1');
    await userEvent.click(deleteBtn);

    // Confirm dialog should appear
    const confirmBtn = screen.getByTestId('confirm-delete-rule-1');
    await userEvent.click(confirmBtn);

    expect(defaultProps.onDelete).toHaveBeenCalledWith('rule-1');
  });

  it('shows empty state when no rules', () => {
    render(<VfdAutomationRuleList {...defaultProps} rules={[]} />);
    expect(screen.getByText('No automation rules yet')).toBeTruthy();
  });

  it('create rule button opens form', async () => {
    render(<VfdAutomationRuleList {...defaultProps} />);
    const createBtn = screen.getByText('Create Rule');
    await userEvent.click(createBtn);
    expect(screen.getByText('Create Automation Rule')).toBeTruthy();
  });
});

// ============================================================================
// VfdAuditLogViewer Tests
// ============================================================================

describe('VfdAuditLogViewer', () => {
  const noop = vi.fn();
  const defaultLogs = [
    makeAuditLog(),
    makeAuditLog({
      id: 'log-2', parameterName: 'P003',
      previousValue: 5.0, newValue: 8.0,
      metadata: { riskLevel: VfdRiskLevel.LOW },
    }),
    makeAuditLog({
      id: 'log-3', parameterName: 'P001',
      previousValue: 400, newValue: 380,
      action: 'AUTOMATION_RULE',
      performedBy: 'automation',
      metadata: { riskLevel: VfdRiskLevel.HIGH },
    }),
  ];

  it('renders log table', () => {
    render(
      <VfdAuditLogViewer
        logs={defaultLogs}
        loading={false}
        error={null}
        hasMore={false}
        onLoadMore={noop}
        availableParameters={['P001', 'P003', 'P005']}
        onParameterFilter={noop}
      />,
    );
    expect(screen.getByTestId('audit-table')).toBeTruthy();
    expect(screen.getByTestId('audit-row-log-1')).toBeTruthy();
    expect(screen.getByTestId('audit-row-log-2')).toBeTruthy();
    expect(screen.getByTestId('audit-row-log-3')).toBeTruthy();
  });

  it('parameter filter calls handler', async () => {
    render(
      <VfdAuditLogViewer
        logs={defaultLogs}
        loading={false}
        error={null}
        hasMore={false}
        onLoadMore={noop}
        availableParameters={['P001', 'P003', 'P005']}
        onParameterFilter={noop}
      />,
    );

    const filter = screen.getByLabelText('Filter by parameter') as HTMLSelectElement;
    await userEvent.selectOptions(filter, 'P003');
    expect(noop).toHaveBeenCalledWith('P003');
  });

  it('pagination loads more', () => {
    const loadMore = vi.fn();
    render(
      <VfdAuditLogViewer
        logs={defaultLogs}
        loading={false}
        error={null}
        hasMore={true}
        onLoadMore={loadMore}
        availableParameters={[]}
        onParameterFilter={noop}
      />,
    );

    const loadMoreBtn = screen.getByText('Load More');
    fireEvent.click(loadMoreBtn);
    expect(loadMore).toHaveBeenCalled();
  });

  it('risk level colors correct', () => {
    render(
      <VfdAuditLogViewer
        logs={defaultLogs}
        loading={false}
        error={null}
        hasMore={false}
        onLoadMore={noop}
        availableParameters={[]}
        onParameterFilter={noop}
      />,
    );

    const medRisk = screen.getByTestId('risk-log-1');
    expect(medRisk.className).toContain('bg-yellow');

    const highRisk = screen.getByTestId('risk-log-3');
    expect(highRisk.className).toContain('bg-orange');
  });

  it('shows empty state', () => {
    render(
      <VfdAuditLogViewer
        logs={[]}
        loading={false}
        error={null}
        hasMore={false}
        onLoadMore={noop}
        availableParameters={[]}
        onParameterFilter={noop}
      />,
    );
    expect(screen.getByText('No audit log entries')).toBeTruthy();
  });
});

// ============================================================================
// VfdDraftBar Tests
// ============================================================================

describe('VfdDraftBar', () => {
  it('hidden when no draft items', () => {
    render(<VfdDraftBar />);
    expect(screen.queryByTestId('vfd-draft-bar')).toBeNull();
  });

  it('shows correct count', () => {
    const { getState } = useVfdProgrammingStore;
    getState().addDraftItem('P003', 10, 5);
    getState().addDraftItem('P005', 45, 50);

    render(<VfdDraftBar />);
    expect(screen.getByTestId('vfd-draft-bar')).toBeTruthy();
    expect(screen.getByText('2 changes pending')).toBeTruthy();
  });

  it('clear all empties store', async () => {
    const { getState } = useVfdProgrammingStore;
    getState().addDraftItem('P003', 10, 5);

    render(<VfdDraftBar />);
    const clearBtn = screen.getByLabelText('Clear all draft changes');
    await userEvent.click(clearBtn);

    expect(getState().draftItems.size).toBe(0);
  });

  it('opens create dialog', async () => {
    const { getState } = useVfdProgrammingStore;
    getState().addDraftItem('P003', 10, 5);

    render(<VfdDraftBar />);
    const reviewBtn = screen.getByLabelText('Review and create change set');
    await userEvent.click(reviewBtn);

    expect(getState().isCreateDialogOpen).toBe(true);
  });
});

// ============================================================================
// VfdProgrammingPage Tests
// ============================================================================

describe('VfdProgrammingPage', () => {
  // We import the page lazily in Module.tsx, so test the component directly
  // and mock the hooks to avoid GraphQL calls

  // Mock all hooks
  vi.mock('../hooks/useVfdParameterDefinitions', () => ({
    useVfdParameterDefinitions: () => ({
      definitions: [makeParam(), makeWritableParam()],
      loading: false,
      error: null,
      fetchDefinitions: vi.fn(),
      getDefinitionsByGroup: () => new Map(),
      getDefinitionsByCategory: () => new Map(),
      getReadOnlyDefinitions: () => [],
      getWritableDefinitions: () => [],
    }),
  }));

  vi.mock('../hooks/useVfdChangeSets', () => ({
    useVfdChangeSets: () => ({
      changeSets: [makeChangeSet()],
      selectedChangeSet: null,
      loading: false,
      error: null,
      pagination: { total: 1, offset: 0, limit: 20, hasMore: false },
      fetchChangeSets: vi.fn(),
      fetchChangeSet: vi.fn(),
      loadMore: vi.fn(),
      createChangeSet: vi.fn().mockResolvedValue({}),
      submitForApproval: vi.fn().mockResolvedValue({}),
      approveChangeSet: vi.fn().mockResolvedValue({}),
      rejectChangeSet: vi.fn().mockResolvedValue({}),
      applyChangeSet: vi.fn().mockResolvedValue({}),
      rollbackChangeSet: vi.fn().mockResolvedValue({}),
      cancelChangeSet: vi.fn().mockResolvedValue({}),
      getPendingCount: () => 1,
      getByStatus: () => [],
    }),
  }));

  vi.mock('../hooks/useVfdAuditLog', () => ({
    useVfdAuditLog: () => ({
      logs: [makeAuditLog()],
      loading: false,
      error: null,
      fetchLogs: vi.fn(),
      loadMore: vi.fn(),
      pagination: { offset: 0, limit: 50, hasMore: false },
      getLogsByParameter: () => new Map(),
      getLogsByUser: () => new Map(),
    }),
  }));

  vi.mock('../hooks/useVfdAutomationRules', () => ({
    useVfdAutomationRules: () => ({
      rules: [makeRule()],
      selectedRule: null,
      loading: false,
      error: null,
      fetchRules: vi.fn(),
      fetchRule: vi.fn(),
      fetchExecutionHistory: vi.fn(),
      createRule: vi.fn().mockResolvedValue({}),
      updateRule: vi.fn().mockResolvedValue({}),
      deleteRule: vi.fn().mockResolvedValue(true),
      toggleRule: vi.fn().mockResolvedValue({}),
      getActiveRules: () => [],
      getRulesByDevice: () => new Map(),
    }),
  }));

  // Import after mocks are set up
  let VfdProgrammingPage: React.ComponentType;
  beforeEach(async () => {
    const mod = await import('../pages/VfdProgrammingPage');
    VfdProgrammingPage = mod.VfdProgrammingPage;
  });

  it('renders with tabs', () => {
    render(
      <MemoryRouter>
        <VfdProgrammingPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('vfd-programming-page')).toBeTruthy();
    expect(screen.getByTestId('tab-parameters')).toBeTruthy();
    expect(screen.getByTestId('tab-changesets')).toBeTruthy();
    expect(screen.getByTestId('tab-automation')).toBeTruthy();
    expect(screen.getByTestId('tab-audit')).toBeTruthy();
  });

  it('tab navigation works', async () => {
    render(
      <MemoryRouter>
        <VfdProgrammingPage />
      </MemoryRouter>,
    );

    // Click Change Sets tab
    const changeSetsTab = screen.getByTestId('tab-changesets');
    await userEvent.click(changeSetsTab);

    expect(screen.getByTestId('vfd-changeset-list')).toBeTruthy();
  });

  it('device selector changes context', async () => {
    render(
      <MemoryRouter>
        <VfdProgrammingPage />
      </MemoryRouter>,
    );

    const selector = screen.getByTestId('device-selector') as HTMLSelectElement;
    await userEvent.selectOptions(selector, 'vfd-2');

    expect(useVfdProgrammingStore.getState().selectedVfdDeviceId).toBe('vfd-2');
  });
});
