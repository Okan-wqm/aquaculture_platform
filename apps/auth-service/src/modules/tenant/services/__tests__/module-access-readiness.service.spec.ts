/**
 * Module-access readiness, in counts (PKG-06 "Readiness"; ADR-051 §3 and §5, the R4 entry gate).
 *
 * Before any service decides by module grants (R4), the operator has to know who would lose a
 * module they use. The report answers, for one tenant and only as counts:
 *   - the members (no account role) holding no grant at all, by their users.role;
 *   - per enabled owner module, the live grants by module role, and how many members without
 *     its grant wrote to it in the last 90 days — asked of the owner module over
 *     request.<module>.recentWriterIds as auth_service, by users.role, never as a list;
 *   - who reaches payroll today (TENANT_ADMIN and every legacy global MODULE_MANAGER) and who
 *     will by grant (TENANT_ADMIN while hr is enabled, and the hr manager grants).
 * An owner that cannot answer is reported UNAVAILABLE, never as zero; the reserved hydroponics
 * has no writer query and is NOT_TRACKED.
 */
import { stub, stubMember } from '@aquaculture/testing';
import { Logger } from '@nestjs/common';
import type { NatsRequestReply } from '@platform/event-bus';
import {
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  type RecentWriterIdsRequest,
} from '@platform/event-contracts';
import type { DataSource, EntityManager } from 'typeorm';

import { TENANT_MODULES_SQL } from '../../../authentication/services/module-access-reader';
import { CENSUS_GRANTS_SQL, CENSUS_USERS_SQL } from '../module-access-census';
import { ModuleAccessReadinessService } from '../module-access-readiness.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const ADMIN = uuid(1);
const LEGACY_MANAGER = uuid(2);
const FARM_USER = uuid(3);
const HR_MANAGER = uuid(4);
const NO_GRANTS = uuid(5);

interface Seed {
  readonly users: ReadonlyArray<{ id: string; role: string }>;
  readonly enabled: readonly string[];
  readonly grants: ReadonlyArray<{ userId: string; code: string; role: string | null }>;
  /** What each owner answers: a count, or a function of the request. */
  readonly answer?: (subject: string, request: RecentWriterIdsRequest) => Promise<unknown>;
}

interface Harness {
  readonly service: ModuleAccessReadinessService;
  readonly requests: Array<{ subject: string; request: RecentWriterIdsRequest }>;
  readonly steps: string[];
}

function harness(seed: Seed): Harness {
  const steps: string[] = [];
  const requests: Array<{ subject: string; request: RecentWriterIdsRequest }> = [];
  let inTransaction = false;
  const manager = stub<EntityManager>({
    query: stubMember<EntityManager['query']>((sql: string, parameters?: unknown[]) => {
      if (sql.includes('set_config') && parameters?.[0] === 'app.current_tenant') {
        steps.push(`rls:${String(parameters[1])}`);
        return Promise.resolve([]);
      }
      if (!inTransaction) throw new Error('read outside the transaction');
      if (sql === CENSUS_USERS_SQL) {
        steps.push('users');
        return Promise.resolve(seed.users);
      }
      if (sql === TENANT_MODULES_SQL) {
        steps.push('tenant_modules');
        return Promise.resolve(
          seed.enabled.map((code) => ({ code, name: code, defaultRoute: `/${code}` })),
        );
      }
      if (sql === CENSUS_GRANTS_SQL) {
        steps.push('grants');
        return Promise.resolve(seed.grants);
      }
      return Promise.resolve([]);
    }),
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(
      async (work: (transactionManager: EntityManager) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await work(manager);
        } finally {
          inTransaction = false;
        }
      },
    ),
  });
  const requestReply = stub<NatsRequestReply>({
    requestTyped: stubMember<NatsRequestReply['requestTyped']>(
      (subject: string, request: RecentWriterIdsRequest) => {
        if (inTransaction) throw new Error('NATS asked inside the transaction');
        requests.push({ subject, request });
        return seed.answer === undefined
          ? Promise.resolve({ ok: true, data: { recentWriterCount: 0 } })
          : seed.answer(subject, request);
      },
    ),
  });
  return { service: new ModuleAccessReadinessService(dataSource, requestReply), requests, steps };
}

const BASE: Seed = {
  users: [
    { id: ADMIN, role: 'TENANT_ADMIN' },
    { id: LEGACY_MANAGER, role: 'MODULE_MANAGER' },
    { id: FARM_USER, role: 'MODULE_USER' },
    { id: HR_MANAGER, role: 'MODULE_USER' },
    { id: NO_GRANTS, role: 'MODULE_USER' },
  ],
  enabled: ['farm', 'hr', 'sensor', 'alert'],
  grants: [
    { userId: LEGACY_MANAGER, code: 'farm', role: 'MODULE_MANAGER' },
    { userId: FARM_USER, code: 'farm', role: 'MODULE_USER' },
    { userId: HR_MANAGER, code: 'hr', role: 'MODULE_MANAGER' },
    // An administrator's row grants nothing beyond the account role; alert is no owner module,
    // and a roleless row (an R2 container's insert) grants nothing.
    { userId: ADMIN, code: 'farm', role: 'MODULE_USER' },
    { userId: NO_GRANTS, code: 'alert', role: 'MODULE_USER' },
    { userId: NO_GRANTS, code: 'sensor', role: null },
  ],
};

function counts(entries: ReadonlyArray<readonly [string, number]>): Array<{
  role: string;
  count: number;
}> {
  return entries.map(([role, count]) => ({ role, count }));
}

describe('ModuleAccessReadinessService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('reads the census in one transaction bound to the tenant, and asks the owners after it', async () => {
    const world = harness(BASE);

    await world.service.readiness(TENANT);

    expect(world.steps).toEqual([`rls:${TENANT}`, 'users', 'tenant_modules', 'grants']);
    expect(world.requests.length).toBeGreaterThan(0);
  });

  it('counts the members without any grant and the grants of each enabled owner module', async () => {
    const report = await harness(BASE).service.readiness(TENANT);

    expect(report.windowDays).toBe(90);
    expect(report.membersWithoutGrants).toEqual(
      counts([
        ['MODULE_MANAGER', 0],
        ['MODULE_USER', 1],
      ]),
    );
    expect(report.modules.map((module) => module.moduleCode)).toEqual(['farm', 'hr', 'sensor']);
    expect(report.modules.map((module) => module.grantsByRole)).toEqual([
      counts([
        ['MODULE_MANAGER', 1],
        ['MODULE_USER', 1],
      ]),
      counts([
        ['MODULE_MANAGER', 1],
        ['MODULE_USER', 0],
      ]),
      counts([
        ['MODULE_MANAGER', 0],
        ['MODULE_USER', 0],
      ]),
    ]);
  });

  it('asks each active owner, as auth_service, about the members without its grant, by users.role', async () => {
    const world = harness(BASE);

    await world.service.readiness(TENANT);

    const asked = world.requests.map(({ subject, request }) => ({
      subject,
      caller: request.caller,
      tenantId: request.tenantId,
      windowDays: request.windowDays,
      userIds: [...request.userIds].sort(),
    }));
    const common = { caller: { kind: 'service', service: 'auth_service' }, tenantId: TENANT };
    expect(asked).toEqual([
      // farm: the legacy manager and FARM_USER hold it; the administrator is never asked about.
      {
        subject: MODULE_ACTIVITY_QUERY_SUBJECTS.farm,
        ...common,
        windowDays: 90,
        userIds: [HR_MANAGER, NO_GRANTS].sort(),
      },
      {
        subject: MODULE_ACTIVITY_QUERY_SUBJECTS.hr,
        ...common,
        windowDays: 90,
        userIds: [LEGACY_MANAGER],
      },
      {
        subject: MODULE_ACTIVITY_QUERY_SUBJECTS.hr,
        ...common,
        windowDays: 90,
        userIds: [FARM_USER, NO_GRANTS].sort(),
      },
      {
        subject: MODULE_ACTIVITY_QUERY_SUBJECTS.sensor,
        ...common,
        windowDays: 90,
        userIds: [LEGACY_MANAGER],
      },
      {
        subject: MODULE_ACTIVITY_QUERY_SUBJECTS.sensor,
        ...common,
        windowDays: 90,
        userIds: [FARM_USER, HR_MANAGER, NO_GRANTS].sort(),
      },
    ]);
  });

  it('reports what each owner answered, by users.role', async () => {
    const report = await harness({
      ...BASE,
      answer: (subject, request) =>
        Promise.resolve({
          ok: true,
          data: {
            recentWriterCount:
              subject === MODULE_ACTIVITY_QUERY_SUBJECTS.sensor ? request.userIds.length : 1,
          },
        }),
    }).service.readiness(TENANT);

    expect(report.modules.map((module) => module.recentWritersWithoutGrant)).toEqual([
      {
        status: 'ANSWERED',
        byUserRole: counts([
          ['MODULE_MANAGER', 0],
          ['MODULE_USER', 1],
        ]),
      },
      {
        status: 'ANSWERED',
        byUserRole: counts([
          ['MODULE_MANAGER', 1],
          ['MODULE_USER', 1],
        ]),
      },
      {
        status: 'ANSWERED',
        byUserRole: counts([
          ['MODULE_MANAGER', 1],
          ['MODULE_USER', 3],
        ]),
      },
    ]);
  });

  it('splits a large set into requests of at most 500 ids and sums the counts', async () => {
    const members = Array.from({ length: 501 }, (_unused, index) => ({
      id: uuid(100 + index),
      role: 'MODULE_USER',
    }));
    const world = harness({
      users: members,
      enabled: ['farm'],
      grants: [],
      answer: (_subject, request) =>
        Promise.resolve({ ok: true, data: { recentWriterCount: request.userIds.length } }),
    });

    const report = await world.service.readiness(TENANT);

    expect(world.requests.map(({ request }) => request.userIds.length)).toEqual([500, 1]);
    expect(report.modules[0]?.recentWritersWithoutGrant).toEqual({
      status: 'ANSWERED',
      byUserRole: counts([
        ['MODULE_MANAGER', 0],
        ['MODULE_USER', 501],
      ]),
    });
  });

  it.each([
    ['a transport failure', (): Promise<unknown> => Promise.reject(new Error('timeout'))],
    ['a refusal', (): Promise<unknown> => Promise.resolve({ ok: false, error: 'FORBIDDEN' })],
    ['a malformed reply', (): Promise<unknown> => Promise.resolve({ ok: true, data: { n: 1 } })],
  ])('reports an owner UNAVAILABLE on %s, never as zero', async (_label, failure) => {
    const report = await harness({
      ...BASE,
      answer: (subject) =>
        subject === MODULE_ACTIVITY_QUERY_SUBJECTS.hr
          ? failure()
          : Promise.resolve({ ok: true, data: { recentWriterCount: 0 } }),
    }).service.readiness(TENANT);

    expect(report.modules.map((module) => module.recentWritersWithoutGrant.status)).toEqual([
      'ANSWERED',
      'UNAVAILABLE',
      'ANSWERED',
    ]);
    expect(report.modules[1]?.recentWritersWithoutGrant.byUserRole).toEqual([]);
  });

  it('asks nothing about the reserved hydroponics, which has no writers', async () => {
    const world = harness({ ...BASE, enabled: ['hydroponics'] });

    const report = await world.service.readiness(TENANT);

    expect(world.requests).toEqual([]);
    expect(report.modules).toEqual([
      {
        moduleCode: 'hydroponics',
        grantsByRole: counts([
          ['MODULE_MANAGER', 0],
          ['MODULE_USER', 0],
        ]),
        recentWritersWithoutGrant: { status: 'NOT_TRACKED', byUserRole: [] },
      },
    ]);
  });

  it('counts who reaches payroll today by the global role and from enforcement by grant (D6)', async () => {
    const report = await harness(BASE).service.readiness(TENANT);

    expect(report.payrollViewers).toEqual({
      byGlobalRole: counts([
        ['TENANT_ADMIN', 1],
        ['MODULE_MANAGER', 1],
      ]),
      byGrant: counts([
        ['TENANT_ADMIN', 1],
        ['MODULE_MANAGER', 1],
      ]),
    });
  });

  it('gives no tenant administrator payroll by grant when the tenant has not enabled hr', async () => {
    const report = await harness({ ...BASE, enabled: ['farm'] }).service.readiness(TENANT);

    expect(report.payrollViewers.byGrant).toEqual(
      counts([
        ['TENANT_ADMIN', 0],
        ['MODULE_MANAGER', 0],
      ]),
    );
  });

  it('holds counts only: no user id leaves the service', async () => {
    const report = await harness(BASE).service.readiness(TENANT);

    const serialized = JSON.stringify(report);
    for (const id of [ADMIN, LEGACY_MANAGER, FARM_USER, HR_MANAGER, NO_GRANTS]) {
      expect(serialized).not.toContain(id);
    }
  });
});
