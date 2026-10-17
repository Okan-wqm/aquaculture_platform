/**
 * A fake gateway for the dashboard specs: answers each dashboard operation by
 * its name with a fixture, records every request, and lets a spec replace one
 * answer (an error, an empty list) without restating the rest.
 *
 * The fixtures are one tenant with two fish sites — Ayvalık, whose lowest
 * oxygen is below the configured critical limit and which has an open P1
 * alarm, and Bodrum, quiet — modelled on the Tenant Console D6 design.
 */
export const SITE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const SITE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const TANK_A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
export const TANK_A2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';

export interface RecordedRequest {
  readonly operation: string;
  readonly variables: Record<string, unknown> | undefined;
}

type Answer = (variables: Record<string, unknown> | undefined) => unknown;

const NOW = Date.now();
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

export const FIXTURES: Readonly<Record<string, Answer>> = {
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
  DashboardSiteMeasurements: (variables) => ({
    waterQualityMeasurements: {
      items:
        variables?.['siteId'] === SITE_A
          ? [
              {
                id: 'm-3',
                tankId: TANK_A1,
                equipmentId: null,
                dissolvedOxygen: 5.8,
                measuredAt: minutesAgo(5),
              },
              {
                id: 'm-2',
                tankId: TANK_A2,
                equipmentId: null,
                dissolvedOxygen: 7.4,
                measuredAt: minutesAgo(6),
              },
              {
                id: 'm-1',
                tankId: TANK_A1,
                equipmentId: null,
                dissolvedOxygen: 3.0,
                measuredAt: minutesAgo(300),
              },
            ]
          : [],
    },
  }),
  DashboardParameterLimits: () => ({
    parameterConfigs: [
      { code: 'temperature', warningMin: 10, criticalMin: 8 },
      { code: 'dissolved_oxygen', warningMin: 6.5, criticalMin: 6 },
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
              status: 'in_progress',
              plannedTotalKg: 2000,
              unplannedActualKg: 100,
              meals: [{ actualKg: 600 }, { actualKg: 540 }],
            },
            {
              id: 'plan-2',
              unitId: TANK_A2,
              unitCode: 'B-03',
              status: 'in_progress',
              plannedTotalKg: 1400,
              unplannedActualKg: 0,
              meals: [{ actualKg: 860 }],
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
  DashboardUsersMfa: () => ({
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
          action: 'ROLE_CHANGED',
          entityType: 'User',
          performedBy: 'u-1',
          performedByEmail: 'ayse.demir@x.io',
          createdAt: minutesAgo(12),
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

/** A request handler over the fixtures; `overrides` replaces answers by operation name. */
export function fakeGateway(overrides: Partial<Record<string, Answer>> = {}): {
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
        const answer = overrides[operation] ?? FIXTURES[operation];
        if (answer === undefined) throw new Error(`unanswered operation ${operation}`);
        resolve(answer(variables));
      }),
  };
}
