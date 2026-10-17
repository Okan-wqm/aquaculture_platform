/**
 * A fake gateway for the dashboard specs: answers each dashboard operation by
 * its name with a fixture, records every request, and lets a spec replace one
 * answer (an error, an empty list) without restating the rest.
 *
 * Every fixture is typed as the operation's result (DashboardOperationResults,
 * the supergraph's generated types), so a fixture cannot answer with a value
 * the API never sends — a lower-case enum, a missing field.
 *
 * The fixtures are one tenant with two fish sites — Ayvalık, whose lowest
 * oxygen (a live channel at B-12) is below the configured critical limit and
 * which has an open P1 alarm, and Bodrum, quiet — modelled on the Tenant
 * Console D6 design.
 */
import type { DashboardOperation, DashboardOperationResults } from '../hooks/dashboard.operations';

export const SITE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const SITE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const TANK_A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
export const TANK_A2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';

export interface RecordedRequest {
  readonly operation: string;
  readonly variables: Record<string, unknown> | undefined;
}

type Variables = Record<string, unknown> | undefined;
type Answer<Name extends DashboardOperation> = (
  variables: Variables,
) => DashboardOperationResults[Name];
type Answers = { readonly [Name in DashboardOperation]: Answer<Name> };

const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

function unitIdsOf(variables: Variables): readonly string[] {
  const input = variables?.['input'];
  if (typeof input !== 'object' || input === null || !('unitIds' in input)) return [];
  const { unitIds } = input;
  return Array.isArray(unitIds) ? unitIds.filter((id): id is string => typeof id === 'string') : [];
}

export const FIXTURES: Answers = {
  DashboardActiveSites: () => ({
    activeSites: [
      {
        id: SITE_A,
        code: 'SITE-A',
        name: 'Ayvalık Grow-out',
        type: 'RECIRCULATING',
        timezone: 'Europe/Istanbul',
      },
      { id: SITE_B, code: 'SITE-B', name: 'Bodrum Hatchery', type: 'HATCHERY', timezone: null },
    ],
  }),
  DashboardSiteAlarmCounts: () => ({
    activeAlertCounts: [
      { severity: 'CRITICAL', acknowledged: false, siteId: SITE_A, count: 1 },
      { severity: 'WARNING', acknowledged: true, siteId: SITE_A, count: 2 },
      { severity: 'INFO', acknowledged: false, siteId: SITE_B, count: 9 },
    ],
  }),
  DashboardModuleAlarms: () => ({
    open: [
      {
        id: 'alarm-1',
        ruleName: 'DO low',
        message: 'Dissolved oxygen 4.1 mg/L in B-12',
        severity: 'CRITICAL',
        acknowledged: false,
        resolved: false,
        triggeredAt: minutesAgo(12),
        siteId: SITE_A,
      },
      {
        id: 'alarm-2',
        ruleName: 'Feed missed',
        message: 'Meal at 08:00 not fed',
        severity: 'WARNING',
        acknowledged: true,
        resolved: false,
        triggeredAt: minutesAgo(90),
        siteId: SITE_B,
      },
    ],
    returned: [
      {
        id: 'alarm-3',
        ruleName: 'Temperature high',
        message: 'Water temperature back in range',
        severity: 'HIGH',
        acknowledged: false,
        resolved: true,
        triggeredAt: minutesAgo(40),
        siteId: null,
      },
    ],
  }),
  DashboardSiteGateways: (variables) => ({
    edgeDevices: {
      items:
        variables?.['siteId'] === SITE_A
          ? [
              { id: 'gw-1', isOnline: true, lastSeenAt: minutesAgo(1) },
              { id: 'gw-2', isOnline: false, lastSeenAt: minutesAgo(70) },
            ]
          : [],
      total: variables?.['siteId'] === SITE_A ? 2 : 0,
    },
  }),
  DashboardUnitOxygen: (variables) => ({
    resolvedUnitParameterValues: unitIdsOf(variables).map((unitId) =>
      unitId === TANK_A1
        ? {
            point: { id: TANK_A1 },
            value: 5.8,
            unit: 'mg/L',
            sourceKind: 'CHANNEL_PRIMARY',
            observedAt: minutesAgo(5),
            unresolved: null,
          }
        : {
            point: { id: unitId },
            value: 7.4,
            unit: 'mg/L',
            sourceKind: 'MANUAL',
            observedAt: minutesAgo(120),
            unresolved: null,
          },
    ),
  }),
  DashboardParameterLimits: () => ({
    parameterConfigs: [
      { id: 'pc-temp', code: 'temperature', unit: '°C', warningMin: 10, criticalMin: 8 },
      { id: 'pc-do', code: 'dissolved_oxygen', unit: 'mg/L', warningMin: 6.5, criticalMin: 6 },
    ],
  }),
  DashboardSiteDayPlans: (variables) => ({
    feedingDayPlans:
      variables?.['siteId'] === SITE_A
        ? [
            {
              id: 'plan-1',
              unitId: TANK_A1,
              unitCode: 'B-12',
              status: 'IN_PROGRESS',
              plannedTotalKg: 2000,
              unplannedActualKg: 100,
              meals: [
                { actualKg: 600, plannedKg: 700, scheduledAt: minutesAgo(240), status: 'FED' },
                { actualKg: 540, plannedKg: 700, scheduledAt: minutesAgo(60), status: 'FED' },
                {
                  actualKg: 0,
                  plannedKg: 600,
                  scheduledAt: minutesAhead(120),
                  status: 'SCHEDULED',
                },
              ],
            },
            {
              id: 'plan-2',
              unitId: TANK_A2,
              unitCode: 'B-03',
              status: 'IN_PROGRESS',
              plannedTotalKg: 1400,
              unplannedActualKg: 0,
              meals: [
                { actualKg: 860, plannedKg: 900, scheduledAt: minutesAgo(200), status: 'FED' },
                { actualKg: 0, plannedKg: 500, scheduledAt: minutesAhead(60), status: 'SCHEDULED' },
              ],
            },
          ]
        : [],
  }),
  DashboardUnitTemperatures: () => ({
    effectiveUnitTemperatures: [
      { unitId: TANK_A1, celsius: 22.1, measuredAt: minutesAgo(3) },
      { unitId: TANK_A2, celsius: 24.6, measuredAt: minutesAgo(30) },
    ],
  }),
  DashboardSiteSystems: (variables) => ({
    systems: {
      items:
        variables?.['siteId'] === SITE_A
          ? [{ id: 's-1', tankCount: 18 }]
          : [{ id: 's-2', tankCount: null }],
    },
  }),
  DashboardSiteSensorTotal: (variables) => ({
    sensors: { total: variables?.['siteId'] === SITE_A ? 12 : 0 },
  }),
  DashboardSitePlcs: (variables) => ({
    plcConnectionsBySite:
      variables?.['siteId'] === SITE_A ? [{ id: 'plc-1', status: 'ONLINE' }] : [],
  }),
  DashboardActivePlcAlarms: () => ({
    activePlcAlarms: [{ id: 'pa-1', plcConnectionId: 'plc-1' }],
  }),
  DashboardSeats: () => ({
    tenantBilling: { planLimits: { maxUsers: 15, currentUsers: 11 } },
    tenantStats: { pendingUsers: 3 },
  }),
  DashboardUsers: () => ({
    tenantUsers: [
      {
        id: 'u-1',
        firstName: 'Ingrid',
        lastName: 'Nilsen',
        email: 'ingrid@x.io',
        role: 'TENANT_ADMIN',
        isActive: true,
        mfaEnabled: false,
      },
      {
        id: 'u-2',
        firstName: 'Lars',
        lastName: 'Berg',
        email: 'lars@x.io',
        role: 'MODULE_MANAGER',
        isActive: true,
        mfaEnabled: false,
      },
      {
        id: 'u-3',
        firstName: 'Can',
        lastName: 'Öz',
        email: 'can@x.io',
        role: 'MODULE_USER',
        isActive: true,
        mfaEnabled: false,
      },
    ],
  }),
  DashboardMaintenance: () => ({
    myAnnouncements: [
      {
        id: 'ann-1',
        title: '18 Oct, 02:00–04:00 UTC',
        isActive: true,
        publishAt: minutesAgo(600),
        expiresAt: null,
        createdAt: minutesAgo(700),
      },
    ],
  }),
  DashboardRecentAudit: () => ({
    tenantAuditLogs: {
      data: [
        {
          id: 'audit-1',
          action: 'USER_ROLE_CHANGED',
          entityType: 'User',
          performedBy: 'u-1',
          performedByEmail: 'ingrid@x.io',
          createdAt: minutesAgo(12),
        },
        {
          id: 'audit-2',
          action: 'LOGIN_SUCCESS',
          entityType: 'User',
          performedBy: 'f0f0f0f0-0000-4000-8000-0000000000f0',
          performedByEmail: null,
          createdAt: minutesAgo(30),
        },
        {
          id: 'audit-3',
          action: 'BACKUP_EXPORTED',
          entityType: 'Tenant',
          performedBy: 'u-2',
          performedByEmail: 'lars@x.io',
          createdAt: minutesAgo(45),
        },
      ],
    },
  }),
  DashboardAcknowledgeAlert: (variables) => ({
    acknowledgeAlert: {
      id: (variables?.['input'] as { alertId: string }).alertId,
      acknowledged: true,
    },
  }),
};

export function operationOf(document: string): string {
  const match = /(?:query|mutation)\s+(\w+)/.exec(document);
  if (match?.[1] === undefined) throw new Error(`no operation name in ${document}`);
  return match[1];
}

function isOperation(name: string): name is DashboardOperation {
  return Object.prototype.hasOwnProperty.call(FIXTURES, name);
}

/** A request handler over the fixtures; `overrides` replaces answers by operation name. */
export function fakeGateway(overrides: Partial<Answers> = {}): {
  request: (document: string, variables?: Record<string, unknown>) => Promise<unknown>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    // A throwing answer rejects, as a failed request does.
    request: (document, variables) =>
      new Promise((resolve) => {
        const operation = operationOf(document);
        requests.push({ operation, variables });
        if (!isOperation(operation)) throw new Error(`unanswered operation ${operation}`);
        const answer: (variables: Variables) => unknown =
          overrides[operation] ?? FIXTURES[operation];
        resolve(answer(variables));
      }),
  };
}
