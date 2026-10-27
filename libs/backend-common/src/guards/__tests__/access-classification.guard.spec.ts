import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MODULE_ACCESS_DENIED_METRIC,
  MODULE_ACCESS_DENIED_REGISTRY,
} from '../../metrics/module-access-denied.metrics';
import { AccessClassificationGuard } from '../access-classification.guard';

import {
  FixtureController,
  FixtureResolver,
  PublicClassResolver,
  SensorClassResolver,
  graphqlContext,
  httpContext,
  member,
} from './access-context.fixture';

/**
 * AccessClassificationGuard (RBAC-HIGH-030; ADR-051 §3 step 2): in an enrolled service a root
 * field or REST handler that has neither `@Access(...)` nor `@Public()` is denied, whoever calls;
 * a classified or public one passes on to RolesGuard. It decides from metadata alone.
 */
describe('AccessClassificationGuard', () => {
  const guard = new AccessClassificationGuard(new Reflector(), 'sensor-service');
  const tenantAdmin = Object.freeze({ method: 'GET', user: member({ roles: ['TENANT_ADMIN'] }) });

  async function unclassifiedDenials(): Promise<number> {
    const metric = MODULE_ACCESS_DENIED_REGISTRY.getSingleMetric(MODULE_ACCESS_DENIED_METRIC);
    if (metric === undefined) throw new Error(`${MODULE_ACCESS_DENIED_METRIC} is not registered`);
    const { values } = await metric.get();
    const sample = values.find(
      (entry) =>
        entry.labels['service'] === 'sensor-service' &&
        entry.labels['spec_kind'] === 'unclassified',
    );
    return sample === undefined ? 0 : sample.value;
  }

  it.each(['unclassified', 'noRoles', 'adminOnly'])(
    'denies the root field %s, which declares no @Access, even to a TENANT_ADMIN',
    (handler) => {
      expect(() =>
        guard.canActivate(graphqlContext(FixtureResolver, handler, tenantAdmin)),
      ).toThrow(ForbiddenException);
    },
  );

  it('denies a REST handler without @Access', () => {
    expect(() =>
      guard.canActivate(httpContext(FixtureController, 'unclassified', tenantAdmin)),
    ).toThrow(ForbiddenException);
  });

  it.each(['payrolls', 'batches', 'myProfile', 'companyTree', 'createTenantRole'])(
    'passes the classified root field %s on to RolesGuard',
    (handler) => {
      expect(guard.canActivate(graphqlContext(FixtureResolver, handler, tenantAdmin))).toBe(true);
    },
  );

  it('passes a handler classified by its class', () => {
    expect(guard.canActivate(graphqlContext(SensorClassResolver, 'readings', tenantAdmin))).toBe(
      true,
    );
  });

  it('passes a @Public handler, authenticated or not', () => {
    expect(guard.canActivate(graphqlContext(FixtureResolver, 'health', { method: 'POST' }))).toBe(
      true,
    );
  });

  it('passes a class-level @Public handler, and one declaring @Access under it on to RolesGuard', () => {
    expect(
      guard.canActivate(graphqlContext(PublicClassResolver, 'status', { method: 'POST' })),
    ).toBe(true);
    expect(guard.canActivate(graphqlContext(PublicClassResolver, 'payrolls', tenantAdmin))).toBe(
      true,
    );
  });

  it('passes a classified REST handler', () => {
    expect(guard.canActivate(httpContext(FixtureController, 'read', tenantAdmin))).toBe(true);
  });

  it('counts each denial as unclassified for its service', async () => {
    const before = await unclassifiedDenials();
    expect(() =>
      guard.canActivate(graphqlContext(FixtureResolver, 'unclassified', tenantAdmin)),
    ).toThrow(ForbiddenException);
    expect(await unclassifiedDenials()).toBe(before + 1);
  });
});
