/**
 * @vitest-environment jsdom
 *
 * Comprehensive tests for VFD Programming hooks and store.
 * Uses vi.mock for graphqlFetch — no real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useVfdParameterDefinitions } from '../hooks/useVfdParameterDefinitions';
import { useVfdChangeSets } from '../hooks/useVfdChangeSets';
import { useVfdAuditLog } from '../hooks/useVfdAuditLog';
import { useVfdAutomationRules } from '../hooks/useVfdAutomationRules';
import { useVfdProgrammingStore } from '../store/vfdProgrammingStore';
import type {
  VfdParameterDefinition,
  VfdChangeSet,
  VfdChangeSetItem,
  VfdParameterAuditLog,
  VfdAutomationRule,
} from '../types/vfd.types';
import {
  VfdChangeSetStatus,
  VfdRiskLevel,
  VfdProgrammingParameterCategory,
} from '../types/vfd.types';

// ============================================================================
// Mock graphqlFetch
// ============================================================================

const mockGraphqlFetch = vi.fn();

vi.mock('../config/api', () => ({
  graphqlFetch: (...args: unknown[]) => mockGraphqlFetch(...args),
}));

// ============================================================================
// Test fixtures
// ============================================================================

function createMockParameterDefinition(
  overrides: Partial<VfdParameterDefinition> = {},
): VfdParameterDefinition {
  return {
    id: 'pd-001',
    tenantId: 'tenant-1',
    brand: 'danfoss',
    modelSeries: 'FC302',
    parameterName: 'accel_time',
    displayName: 'Acceleration Time',
    description: 'Motor acceleration ramp time',
    category: 'configuration',
    group: 'ramp_times',
    registerAddress: 100,
    registerCount: 1,
    functionCode: 6,
    dataType: 'uint16',
    scalingFactor: 0.1,
    offset: 0,
    unit: 's',
    byteOrder: 'big',
    wordOrder: 'big',
    minValue: 0.1,
    maxValue: 3600,
    defaultValue: 10,
    step: 0.1,
    riskLevel: VfdRiskLevel.LOW,
    requiresMotorStop: false,
    isReadable: true,
    isWritable: true,
    isActive: true,
    displayOrder: 1,
    metadata: null,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

function createMockChangeSetItem(overrides: Partial<VfdChangeSetItem> = {}): VfdChangeSetItem {
  return {
    id: 'csi-001',
    changeSetId: 'cs-001',
    parameterDefinitionId: 'pd-001',
    parameterName: 'accel_time',
    previousValue: 10,
    requestedValue: 5,
    appliedValue: null,
    status: 'pending',
    errorMessage: null,
    appliedAt: null,
    createdAt: '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

function createMockChangeSet(overrides: Partial<VfdChangeSet> = {}): VfdChangeSet {
  return {
    id: 'cs-001',
    tenantId: 'tenant-1',
    vfdDeviceId: 'vfd-001',
    status: VfdChangeSetStatus.DRAFT,
    description: 'Adjust ramp times',
    createdBy: 'user-1',
    approvedBy: null,
    rejectedBy: null,
    rejectionReason: null,
    appliedAt: null,
    verifiedAt: null,
    scheduledAt: null,
    automationRuleId: null,
    rollbackOfId: null,
    metadata: null,
    items: [createMockChangeSetItem()],
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

function createMockAuditLog(overrides: Partial<VfdParameterAuditLog> = {}): VfdParameterAuditLog {
  return {
    id: 'al-001',
    tenantId: 'tenant-1',
    vfdDeviceId: 'vfd-001',
    changeSetId: 'cs-001',
    parameterName: 'accel_time',
    previousValue: 10,
    newValue: 5,
    action: 'apply',
    performedBy: 'user-1',
    clientIp: '192.168.1.10',
    userAgent: 'AquaSCADA/1.0',
    automationRuleId: null,
    metadata: null,
    timestamp: '2026-03-20T11:00:00Z',
    ...overrides,
  };
}

function createMockAutomationRule(overrides: Partial<VfdAutomationRule> = {}): VfdAutomationRule {
  return {
    id: 'ar-001',
    tenantId: 'tenant-1',
    name: 'High Temp Protection',
    description: 'Reduce speed when motor temperature exceeds 80C',
    triggerCondition: {
      conditions: [{ sensorTag: 'motor_temp', operator: '>', value: 80 }],
      logicalOperator: 'AND',
      cooldownSeconds: 300,
    },
    targetVfdDeviceIds: ['vfd-001', 'vfd-002'],
    parameterChanges: [{ parameterName: 'max_speed', value: 50 }],
    requiresApproval: true,
    priority: 100,
    isActive: true,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdBy: 'user-1',
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// 1. useVfdParameterDefinitions (8+ tests)
// ============================================================================

describe('useVfdParameterDefinitions', () => {
  beforeEach(() => {
    mockGraphqlFetch.mockReset();
  });

  it('fetches definitions on mount with vfdDeviceId', async () => {
    const defs = [createMockParameterDefinition()];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    const { result } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    await waitFor(() => {
      expect(result.current.definitions).toEqual(defs);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('filters by group when provided', async () => {
    const defs = [createMockParameterDefinition()];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    renderHook(() => useVfdParameterDefinitions('vfd-001', 'ramp_times'));

    await waitFor(() => {
      expect(mockGraphqlFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ group: 'ramp_times' }),
      );
    });
  });

  it('groups definitions by category', async () => {
    const defs = [
      createMockParameterDefinition({ id: 'pd-1', category: 'configuration' }),
      createMockParameterDefinition({ id: 'pd-2', category: 'motor' }),
      createMockParameterDefinition({ id: 'pd-3', category: 'configuration' }),
    ];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    const { result } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    await waitFor(() => {
      expect(result.current.definitions).toHaveLength(3);
    });

    const byCategory = result.current.getDefinitionsByCategory();
    expect(byCategory.get('configuration')).toHaveLength(2);
    expect(byCategory.get('motor')).toHaveLength(1);
  });

  it('groups definitions by parameter group', async () => {
    const defs = [
      createMockParameterDefinition({ id: 'pd-1', group: 'ramp_times' }),
      createMockParameterDefinition({ id: 'pd-2', group: 'frequency_limits' }),
      createMockParameterDefinition({ id: 'pd-3', group: 'ramp_times' }),
    ];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    const { result } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    await waitFor(() => {
      expect(result.current.definitions).toHaveLength(3);
    });

    const byGroup = result.current.getDefinitionsByGroup();
    expect(byGroup.get('ramp_times')).toHaveLength(2);
    expect(byGroup.get('frequency_limits')).toHaveLength(1);
  });

  it('identifies read-only vs writable definitions', async () => {
    const defs = [
      createMockParameterDefinition({ id: 'pd-1', isReadable: true, isWritable: false }),
      createMockParameterDefinition({ id: 'pd-2', isReadable: true, isWritable: true }),
      createMockParameterDefinition({ id: 'pd-3', isReadable: true, isWritable: true }),
    ];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    const { result } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    await waitFor(() => {
      expect(result.current.definitions).toHaveLength(3);
    });

    expect(result.current.getReadOnlyDefinitions()).toHaveLength(1);
    expect(result.current.getWritableDefinitions()).toHaveLength(2);
  });

  it('auto-refreshes at 30s interval', async () => {
    vi.useFakeTimers();
    const defs = [createMockParameterDefinition()];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    renderHook(() => useVfdParameterDefinitions('vfd-001'));

    // Flush initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(1);

    // Advance 30 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(2);

    // Advance another 30 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('handles API errors gracefully', async () => {
    mockGraphqlFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
    });

    expect(result.current.definitions).toEqual([]);
  });

  it('cleans up interval on unmount', async () => {
    vi.useFakeTimers();
    const defs = [createMockParameterDefinition()];
    mockGraphqlFetch.mockResolvedValue({ vfdParameterDefinitions: defs });

    const { unmount } = renderHook(() => useVfdParameterDefinitions('vfd-001'));

    // Flush initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(1);

    unmount();

    // Advance time — should NOT trigger additional calls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not fetch when vfdDeviceId is undefined', async () => {
    const { result } = renderHook(() => useVfdParameterDefinitions(undefined));

    // Wait a tick
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGraphqlFetch).not.toHaveBeenCalled();
    expect(result.current.definitions).toEqual([]);
  });
});

// ============================================================================
// 2. useVfdChangeSets (12+ tests)
// ============================================================================

describe('useVfdChangeSets', () => {
  beforeEach(() => {
    mockGraphqlFetch.mockReset();
  });

  it('fetches change sets for a device', async () => {
    const changeSets = [createMockChangeSet()];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdChangeSets: changeSets });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    expect(result.current.changeSets).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('fetches change sets with status filter', async () => {
    const changeSets = [createMockChangeSet({ status: VfdChangeSetStatus.PENDING_APPROVAL })];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdChangeSets: changeSets });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001', VfdChangeSetStatus.PENDING_APPROVAL);
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: VfdChangeSetStatus.PENDING_APPROVAL }),
    );
  });

  it('creates a new change set', async () => {
    const created = createMockChangeSet({ id: 'cs-new' });
    mockGraphqlFetch.mockResolvedValueOnce({ createVfdChangeSet: created });

    const { result } = renderHook(() => useVfdChangeSets());

    let changeSet: VfdChangeSet | undefined;
    await act(async () => {
      changeSet = await result.current.createChangeSet({
        vfdDeviceId: 'vfd-001',
        description: 'Test change',
        items: [
          { parameterDefinitionId: 'pd-001', parameterName: 'accel_time', requestedValue: 5 },
        ],
      });
    });

    expect(changeSet?.id).toBe('cs-new');
    expect(result.current.changeSets).toHaveLength(1);
    expect(result.current.selectedChangeSet?.id).toBe('cs-new');
  });

  it('approves a change set', async () => {
    const initial = [createMockChangeSet({ status: VfdChangeSetStatus.PENDING_APPROVAL })];
    const approved = createMockChangeSet({
      status: VfdChangeSetStatus.APPROVED,
      approvedBy: 'admin-1',
    });

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdChangeSets: initial })
      .mockResolvedValueOnce({ approveVfdChangeSet: approved });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    await act(async () => {
      await result.current.approveChangeSet('cs-001');
    });

    expect(result.current.changeSets[0].status).toBe(VfdChangeSetStatus.APPROVED);
  });

  it('rejects a change set with reason', async () => {
    const rejected = createMockChangeSet({
      status: VfdChangeSetStatus.REJECTED,
      rejectionReason: 'Values too aggressive',
    });
    mockGraphqlFetch.mockResolvedValueOnce({ rejectVfdChangeSet: rejected });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.rejectChangeSet('cs-001', 'Values too aggressive');
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(expect.any(String), {
      input: { changeSetId: 'cs-001', reason: 'Values too aggressive' },
    });
  });

  it('applies an approved change set', async () => {
    const applied = createMockChangeSet({ status: VfdChangeSetStatus.APPROVED });
    mockGraphqlFetch.mockResolvedValueOnce({ approveVfdChangeSet: applied });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.applyChangeSet('cs-001');
    });

    expect(result.current.selectedChangeSet?.status).toBe(VfdChangeSetStatus.APPROVED);
  });

  it('rolls back an applied change set', async () => {
    const rolledBack = createMockChangeSet({ status: VfdChangeSetStatus.ROLLED_BACK });
    mockGraphqlFetch.mockResolvedValueOnce({ rollbackVfdChangeSet: rolledBack });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.rollbackChangeSet('cs-001', 'Causing issues');
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(expect.any(String), {
      input: { changeSetId: 'cs-001', reason: 'Causing issues' },
    });
  });

  it('cancels a draft change set', async () => {
    const cancelled = createMockChangeSet({ id: 'cs-001' });
    mockGraphqlFetch.mockResolvedValueOnce({ cancelVfdChangeSet: cancelled });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.cancelChangeSet('cs-001');
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(expect.any(String), { changeSetId: 'cs-001' });
  });

  it('supports pagination with loadMore', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) =>
      createMockChangeSet({
        id: `cs-${i}`,
        createdAt: `2026-03-20T${String(i).padStart(2, '0')}:00:00Z`,
      }),
    );
    const page2 = [createMockChangeSet({ id: 'cs-20', createdAt: '2026-03-19T10:00:00Z' })];

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdChangeSets: page1 })
      .mockResolvedValueOnce({ vfdChangeSets: page2 });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    expect(result.current.pagination.hasMore).toBe(true);
    expect(result.current.changeSets).toHaveLength(20);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.changeSets).toHaveLength(21);
    expect(result.current.pagination.hasMore).toBe(false);
  });

  it('getPendingCount returns correct count', async () => {
    const changeSets = [
      createMockChangeSet({ id: 'cs-1', status: VfdChangeSetStatus.PENDING_APPROVAL }),
      createMockChangeSet({ id: 'cs-2', status: VfdChangeSetStatus.PENDING_APPROVAL }),
      createMockChangeSet({ id: 'cs-3', status: VfdChangeSetStatus.DRAFT }),
      createMockChangeSet({ id: 'cs-4', status: VfdChangeSetStatus.APPLIED }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdChangeSets: changeSets });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    expect(result.current.getPendingCount()).toBe(2);
  });

  it('handles concurrent mutation errors', async () => {
    mockGraphqlFetch.mockRejectedValueOnce(new Error('Conflict: change set already approved'));

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await expect(result.current.approveChangeSet('cs-001')).rejects.toThrow(
        'Conflict: change set already approved',
      );
    });

    expect(result.current.error).toBe('Conflict: change set already approved');
  });

  it('sorts by createdAt descending', async () => {
    const changeSets = [
      createMockChangeSet({ id: 'cs-1', createdAt: '2026-03-18T10:00:00Z' }),
      createMockChangeSet({ id: 'cs-2', createdAt: '2026-03-20T10:00:00Z' }),
      createMockChangeSet({ id: 'cs-3', createdAt: '2026-03-19T10:00:00Z' }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdChangeSets: changeSets });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    expect(result.current.changeSets[0].id).toBe('cs-2');
    expect(result.current.changeSets[1].id).toBe('cs-3');
    expect(result.current.changeSets[2].id).toBe('cs-1');
  });

  it('getByStatus filters correctly', async () => {
    const changeSets = [
      createMockChangeSet({ id: 'cs-1', status: VfdChangeSetStatus.DRAFT }),
      createMockChangeSet({ id: 'cs-2', status: VfdChangeSetStatus.APPLIED }),
      createMockChangeSet({ id: 'cs-3', status: VfdChangeSetStatus.DRAFT }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdChangeSets: changeSets });

    const { result } = renderHook(() => useVfdChangeSets());

    await act(async () => {
      await result.current.fetchChangeSets('vfd-001');
    });

    const drafts = result.current.getByStatus(VfdChangeSetStatus.DRAFT);
    expect(drafts).toHaveLength(2);
  });
});

// ============================================================================
// 3. useVfdAuditLog (6+ tests)
// ============================================================================

describe('useVfdAuditLog', () => {
  beforeEach(() => {
    mockGraphqlFetch.mockReset();
  });

  it('fetches audit logs for device', async () => {
    const logs = [createMockAuditLog()];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdParameterAuditLog: logs });

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001');
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('filters by parameterName', async () => {
    const logs = [createMockAuditLog()];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdParameterAuditLog: logs });

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001', 'accel_time');
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ parameterName: 'accel_time' }),
    );
  });

  it('pagination works correctly via loadMore', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => createMockAuditLog({ id: `al-${i}` }));
    const page2 = Array.from({ length: 60 }, (_, i) => createMockAuditLog({ id: `al-${i}` }));

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdParameterAuditLog: page1 })
      .mockResolvedValueOnce({ vfdParameterAuditLog: page2 });

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001');
    });

    expect(result.current.pagination.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.logs).toHaveLength(60);
  });

  it('groups logs by parameter', async () => {
    const logs = [
      createMockAuditLog({ id: 'al-1', parameterName: 'accel_time' }),
      createMockAuditLog({ id: 'al-2', parameterName: 'decel_time' }),
      createMockAuditLog({ id: 'al-3', parameterName: 'accel_time' }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdParameterAuditLog: logs });

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001');
    });

    const byParam = result.current.getLogsByParameter();
    expect(byParam.get('accel_time')).toHaveLength(2);
    expect(byParam.get('decel_time')).toHaveLength(1);
  });

  it('groups logs by user', async () => {
    const logs = [
      createMockAuditLog({ id: 'al-1', performedBy: 'user-1' }),
      createMockAuditLog({ id: 'al-2', performedBy: 'user-2' }),
      createMockAuditLog({ id: 'al-3', performedBy: 'user-1' }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdParameterAuditLog: logs });

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001');
    });

    const byUser = result.current.getLogsByUser();
    expect(byUser.get('user-1')).toHaveLength(2);
    expect(byUser.get('user-2')).toHaveLength(1);
  });

  it('handles API errors', async () => {
    mockGraphqlFetch.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useVfdAuditLog());

    await act(async () => {
      await result.current.fetchLogs('vfd-001');
    });

    expect(result.current.error).toBe('Unauthorized');
    expect(result.current.logs).toEqual([]);
  });
});

// ============================================================================
// 4. useVfdAutomationRules (10+ tests)
// ============================================================================

describe('useVfdAutomationRules', () => {
  beforeEach(() => {
    mockGraphqlFetch.mockReset();
  });

  it('fetches rules list (all)', async () => {
    const rules = [createMockAutomationRule()];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdAutomationRules: rules });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    expect(result.current.rules).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('fetches rules for a specific device', async () => {
    const rules = [createMockAutomationRule()];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdAutomationRulesByDevice: rules });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules('vfd-001');
    });

    expect(mockGraphqlFetch).toHaveBeenCalledWith(expect.any(String), { vfdDeviceId: 'vfd-001' });
    expect(result.current.rules).toHaveLength(1);
  });

  it('creates a new rule', async () => {
    const created = createMockAutomationRule({ id: 'ar-new', name: 'New Rule' });
    mockGraphqlFetch.mockResolvedValueOnce({ createVfdAutomationRule: created });

    const { result } = renderHook(() => useVfdAutomationRules());

    let rule: VfdAutomationRule | undefined;
    await act(async () => {
      rule = await result.current.createRule({
        name: 'New Rule',
        description: 'Test rule',
        triggerCondition: { conditions: [], logicalOperator: 'AND', cooldownSeconds: 60 },
        targetVfdDeviceIds: ['vfd-001'],
        parameterChanges: [{ parameterName: 'max_speed', value: 50 }],
        requiresApproval: true,
        priority: 100,
      });
    });

    expect(rule?.id).toBe('ar-new');
    expect(result.current.rules).toHaveLength(1);
  });

  it('updates an existing rule', async () => {
    const initial = [createMockAutomationRule({ id: 'ar-001' })];
    const updated = createMockAutomationRule({ id: 'ar-001', name: 'Updated Rule' });

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdAutomationRules: initial })
      .mockResolvedValueOnce({ updateVfdAutomationRule: updated });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    await act(async () => {
      await result.current.updateRule('ar-001', { name: 'Updated Rule' });
    });

    expect(result.current.rules[0].name).toBe('Updated Rule');
  });

  it('deletes a rule', async () => {
    const initial = [createMockAutomationRule({ id: 'ar-001' })];

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdAutomationRules: initial })
      .mockResolvedValueOnce({ deleteVfdAutomationRule: true });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    expect(result.current.rules).toHaveLength(1);

    await act(async () => {
      await result.current.deleteRule('ar-001');
    });

    expect(result.current.rules).toHaveLength(0);
  });

  it('toggles rule active/inactive', async () => {
    const initial = [createMockAutomationRule({ id: 'ar-001', isActive: true })];
    const toggled = createMockAutomationRule({ id: 'ar-001', isActive: false });

    mockGraphqlFetch
      .mockResolvedValueOnce({ vfdAutomationRules: initial })
      .mockResolvedValueOnce({ toggleVfdAutomationRule: toggled });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    await act(async () => {
      await result.current.toggleRule('ar-001', false);
    });

    expect(result.current.rules[0].isActive).toBe(false);
  });

  it('fetches execution history', async () => {
    const logs = [createMockAuditLog({ automationRuleId: 'ar-001' })];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdAutomationRuleHistory: logs });

    const { result } = renderHook(() => useVfdAutomationRules());

    let history: VfdParameterAuditLog[] = [];
    await act(async () => {
      history = await result.current.fetchExecutionHistory('ar-001');
    });

    expect(history).toHaveLength(1);
  });

  it('filters active rules', async () => {
    const rules = [
      createMockAutomationRule({ id: 'ar-1', isActive: true }),
      createMockAutomationRule({ id: 'ar-2', isActive: false }),
      createMockAutomationRule({ id: 'ar-3', isActive: true }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdAutomationRules: rules });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    expect(result.current.getActiveRules()).toHaveLength(2);
  });

  it('groups rules by device', async () => {
    const rules = [
      createMockAutomationRule({ id: 'ar-1', targetVfdDeviceIds: ['vfd-001', 'vfd-002'] }),
      createMockAutomationRule({ id: 'ar-2', targetVfdDeviceIds: ['vfd-002'] }),
    ];
    mockGraphqlFetch.mockResolvedValueOnce({ vfdAutomationRules: rules });

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await result.current.fetchRules();
    });

    const byDevice = result.current.getRulesByDevice();
    expect(byDevice.get('vfd-001')).toHaveLength(1);
    expect(byDevice.get('vfd-002')).toHaveLength(2);
  });

  it('handles error on createRule', async () => {
    mockGraphqlFetch.mockRejectedValueOnce(new Error('Permission denied'));

    const { result } = renderHook(() => useVfdAutomationRules());

    await act(async () => {
      await expect(
        result.current.createRule({
          name: 'Test',
          description: 'Test',
          triggerCondition: {},
          targetVfdDeviceIds: ['vfd-001'],
          parameterChanges: [],
          requiresApproval: true,
          priority: 100,
        }),
      ).rejects.toThrow('Permission denied');
    });

    expect(result.current.error).toBe('Permission denied');
  });
});

// ============================================================================
// 5. vfdProgrammingStore (8+ tests)
// ============================================================================

describe('vfdProgrammingStore', () => {
  beforeEach(() => {
    // Reset store between tests
    const { getState } = useVfdProgrammingStore;
    act(() => {
      getState().clearDraft();
      getState().setActiveTab('parameters');
      getState().setChangeSetFilter(null);
      if (getState().showAdvancedParams) getState().toggleAdvancedParams();
      if (getState().compareMode) getState().toggleCompareMode();
      getState().setSelectedGroup(null);
      getState().setSelectedCategory(null);
    });
  });

  it('adds and removes draft items', () => {
    const { getState } = useVfdProgrammingStore;

    act(() => {
      getState().addDraftItem('accel_time', 5, 10);
      getState().addDraftItem('decel_time', 3, 8);
    });

    expect(getState().draftItems.size).toBe(2);
    expect(getState().draftItems.get('accel_time')?.newValue).toBe(5);

    act(() => {
      getState().removeDraftItem('accel_time');
    });

    expect(getState().draftItems.size).toBe(1);
    expect(getState().draftItems.has('accel_time')).toBe(false);
  });

  it('clears draft completely', () => {
    const { getState } = useVfdProgrammingStore;

    act(() => {
      getState().addDraftItem('accel_time', 5, 10);
      getState().setDraftTitle('Test Title');
      getState().setDraftDescription('Test Description');
    });

    expect(getState().draftItems.size).toBe(1);
    expect(getState().draftTitle).toBe('Test Title');

    act(() => {
      getState().clearDraft();
    });

    expect(getState().draftItems.size).toBe(0);
    expect(getState().draftTitle).toBe('');
    expect(getState().draftDescription).toBe('');
  });

  it('manages tab navigation', () => {
    const { getState } = useVfdProgrammingStore;

    expect(getState().activeTab).toBe('parameters');

    act(() => {
      getState().setActiveTab('changesets');
    });

    expect(getState().activeTab).toBe('changesets');

    act(() => {
      getState().setActiveTab('automation');
    });

    expect(getState().activeTab).toBe('automation');
  });

  it('toggles advanced params and compare mode', () => {
    const { getState } = useVfdProgrammingStore;

    expect(getState().showAdvancedParams).toBe(false);
    expect(getState().compareMode).toBe(false);

    act(() => {
      getState().toggleAdvancedParams();
    });

    expect(getState().showAdvancedParams).toBe(true);

    act(() => {
      getState().toggleCompareMode();
    });

    expect(getState().compareMode).toBe(true);

    act(() => {
      getState().toggleAdvancedParams();
    });

    expect(getState().showAdvancedParams).toBe(false);
  });

  it('getDraftItemCount and hasDraftChanges compute correctly', () => {
    const { getState } = useVfdProgrammingStore;

    expect(getState().getDraftItemCount()).toBe(0);
    expect(getState().hasDraftChanges()).toBe(false);

    act(() => {
      getState().addDraftItem('accel_time', 5, 10);
    });

    expect(getState().getDraftItemCount()).toBe(1);
    expect(getState().hasDraftChanges()).toBe(true);

    act(() => {
      getState().addDraftItem('decel_time', 3, 8);
    });

    expect(getState().getDraftItemCount()).toBe(2);
  });

  it('manages change set filter state', () => {
    const { getState } = useVfdProgrammingStore;

    expect(getState().changeSetFilter).toBeNull();

    act(() => {
      getState().setChangeSetFilter(VfdChangeSetStatus.PENDING_APPROVAL);
    });

    expect(getState().changeSetFilter).toBe(VfdChangeSetStatus.PENDING_APPROVAL);

    act(() => {
      getState().setChangeSetFilter(null);
    });

    expect(getState().changeSetFilter).toBeNull();
  });

  it('resets draft when switching device', () => {
    const { getState } = useVfdProgrammingStore;

    act(() => {
      getState().addDraftItem('accel_time', 5, 10);
      getState().setDraftTitle('Test');
    });

    expect(getState().draftItems.size).toBe(1);

    act(() => {
      getState().setSelectedDevice('vfd-002');
    });

    expect(getState().selectedVfdDeviceId).toBe('vfd-002');
    expect(getState().draftItems.size).toBe(0);
    expect(getState().draftTitle).toBe('');
  });

  it('manages selected category and group', () => {
    const { getState } = useVfdProgrammingStore;

    act(() => {
      getState().setSelectedGroup('ramp_times');
    });

    expect(getState().selectedParameterGroup).toBe('ramp_times');

    act(() => {
      getState().setSelectedCategory(VfdProgrammingParameterCategory.MOTOR);
    });

    expect(getState().selectedCategory).toBe(VfdProgrammingParameterCategory.MOTOR);

    act(() => {
      getState().setSelectedGroup(null);
      getState().setSelectedCategory(null);
    });

    expect(getState().selectedParameterGroup).toBeNull();
    expect(getState().selectedCategory).toBeNull();
  });
});
