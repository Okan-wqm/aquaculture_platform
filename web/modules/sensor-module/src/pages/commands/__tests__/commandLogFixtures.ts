/**
 * Wire-shaped fixtures for the command log page tests: enums arrive by NAME and
 * timestamps as ISO strings; absent nullable fields arrive as `null` where the
 * row type is the generated one (audit and deployment rows). FeedingParameter
 * is usePlcControl's hand-written type, which spells absence as `undefined`.
 *
 * Actors arrive as sensor-service writes them: the id is the JWT subject (a
 * user UUID), the e-mail sits beside it — or is null on rows recorded before
 * the e-mail was kept.
 */

/** JWT subjects: what `createdBy` / `deployedBy` / `performedBy` hold. */
export const FEED_MANAGER_ID = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
export const AUTOMATION_ENGINEER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const OPERATOR_ID = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
import type { VfdCommandAuditEntry } from '../../../hooks/useVfdCommandAuditLog';
import type { DeploymentHistoryEntry } from '../../../hooks/useDeploymentHistory';
import type { FeedingParameter } from '../../../hooks/usePlcControl';

export const VFD_DEVICES = [
  {
    id: 'vfd-1',
    name: 'Blower B-1',
    brand: 'DANFOSS',
    model: 'FC302',
    protocol: 'MODBUS_TCP',
    connectionStatus: null,
    status: 'ACTIVE',
    location: null,
    createdAt: '2026-09-01T08:00:00.000Z',
  },
  {
    id: 'vfd-2',
    name: 'Feed pump P-4',
    brand: 'ABB',
    model: 'ACS580',
    protocol: 'MODBUS_TCP',
    connectionStatus: null,
    status: 'ACTIVE',
    location: null,
    createdAt: '2026-09-02T08:00:00.000Z',
  },
];

export function vfdEntry(overrides: Partial<VfdCommandAuditEntry>): VfdCommandAuditEntry {
  return {
    id: 'cmd-1',
    vfdDeviceId: 'vfd-1',
    command: 'SET_FREQUENCY',
    value: 42.5,
    success: true,
    error: null,
    performedBy: OPERATOR_ID,
    performedByEmail: 'operator@farm.test',
    source: 'operator',
    latencyMs: 180,
    timestamp: '2026-10-16T08:12:04.000Z',
    ...overrides,
  };
}

export function feedingParameter(overrides: Partial<FeedingParameter>): FeedingParameter {
  return {
    id: 'fp-1',
    plcConnectionId: 'plc-1',
    tankId: undefined,
    name: 'Spring ration',
    description: undefined,
    version: '3',
    biomassKg: 1200,
    fcr: 1.1,
    targetDailyFeedKg: 24,
    schedule: [],
    thresholds: { oxygenMin: 5, oxygenCritical: 4, tempMax: 18, tempCritical: 20 },
    vfdSettings: { blowerMinSpeed: 10, blowerMaxSpeed: 90, doserMinSpeed: 10, doserMaxSpeed: 90 },
    status: 'SENT',
    sentAt: '2026-10-16T06:00:00.000Z',
    acknowledgedAt: undefined,
    errorMessage: undefined,
    createdBy: FEED_MANAGER_ID,
    createdByEmail: 'feed.manager@farm.test',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-16T06:00:00.000Z',
    connection: { id: 'plc-1', name: 'Hall A PLC', status: 'ONLINE' },
    ...overrides,
  };
}

export function deployment(overrides: Partial<DeploymentHistoryEntry>): DeploymentHistoryEntry {
  return {
    id: 'dep-1',
    programId: 'prog-1',
    deviceId: 'edge-1',
    commandId: 'cmd-dep-1',
    status: 'SUCCESS',
    version: 4,
    deployedBy: AUTOMATION_ENGINEER_ID,
    deployedByEmail: 'automation.engineer@farm.test',
    deployedAt: '2026-10-15T14:00:00.000Z',
    completedAt: '2026-10-15T14:00:09.000Z',
    edgeAckAt: '2026-10-15T14:00:08.000Z',
    errorMessage: null,
    ...overrides,
  };
}

export const AUTOMATION_PROGRAMS = [
  {
    id: 'prog-1',
    programCode: 'AER-01',
    programName: 'Aeration cycle',
    status: 'ACTIVE',
    variableCount: 3,
  },
];

export const EDGE_DEVICES = [
  { id: 'edge-1', deviceCode: 'EG-HALL-A', deviceName: 'Hall A gateway' },
];
