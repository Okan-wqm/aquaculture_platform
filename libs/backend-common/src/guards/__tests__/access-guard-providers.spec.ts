import { ForbiddenException, type FactoryProvider, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';

import { moduleAccessServiceLabel } from '../../metrics/module-access-denied.metrics';
import {
  ACCESS_ENROLLED_SERVICES,
  MODULE_ACCESS_ENROLMENT,
  moduleAccessServices,
  type AccessEnrolledService,
} from '../../security/access-enrolment';
import { AccessClassificationGuard } from '../access-classification.guard';
import {
  MODULE_ACCESS_SERVICE,
  accessGuardProviders,
  guardProvidersForEnrolment,
} from '../access-guard-providers';
import { RolesGuard } from '../roles.guard';

import {
  FixtureResolver,
  PublicClassResolver,
  graphqlContext,
  member,
} from './access-context.fixture';
import { ACCOUNT_ROLE_CASES } from './account-role.cases';

/**
 * Plan PKG-05 accept: services not yet enrolled behave exactly as before (ADR-051 §3,
 * "Enrolment"). Every service registers its guards through `accessGuardProviders`, and in R1
 * every MODULE_ACCESS_ENROLMENT entry is `account-role`, so each service gets exactly the one
 * APP_GUARD it had — RolesGuard — answering every pre-ADR-051 case as before. The `module-access`
 * wiring is proven on an enrolment value, since no service is enrolled yet.
 */

function isFactoryProvider(provider: Provider): provider is FactoryProvider {
  return typeof provider === 'object' && 'useFactory' in provider;
}

function appGuards(providers: readonly Provider[]): unknown[] {
  return providers
    .filter(isFactoryProvider)
    .filter((provider) => provider.provide === APP_GUARD)
    .map((provider): unknown => {
      const guard: unknown = provider.useFactory(new Reflector());
      return guard;
    });
}

function decide(guard: RolesGuard, handler: string, user: object | undefined): boolean {
  const request = user === undefined ? { method: 'POST' } : { method: 'POST', user };
  try {
    return guard.canActivate(graphqlContext(FixtureResolver, handler, request));
  } catch (error: unknown) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}

describe('accessGuardProviders — R1 enrols no service (PKG-05 lands every entry account-role)', () => {
  it('lists the 11 services that registered RolesGuard as an APP_GUARD, all account-role', () => {
    expect(Object.keys(MODULE_ACCESS_ENROLMENT).sort()).toEqual(
      [...ACCESS_ENROLLED_SERVICES].sort(),
    );
    expect(ACCESS_ENROLLED_SERVICES).toHaveLength(11);
    expect(moduleAccessServices()).toEqual([]);
  });

  it('types its argument by the map: a service missing from it does not compile', () => {
    type Enrolled<S extends string> = S extends AccessEnrolledService ? true : false;
    const gatewayEnrolled: Enrolled<'gateway-api'> = false;
    const farmEnrolled: Enrolled<'farm-service'> = true;
    expect([gatewayEnrolled, farmEnrolled]).toEqual([false, true]);
  });
});

describe.each(
  ACCESS_ENROLLED_SERVICES.filter((s) => MODULE_ACCESS_ENROLMENT[s] === 'account-role'),
)('%s (account-role) behaves exactly as before', (service) => {
  const providers = accessGuardProviders(service);

  it('registers exactly one provider: the RolesGuard APP_GUARD', () => {
    expect(providers).toHaveLength(1);
    const guards = appGuards(providers);
    expect(guards).toHaveLength(1);
    expect(guards[0]).toBeInstanceOf(RolesGuard);
    expect(guards.some((guard) => guard instanceof AccessClassificationGuard)).toBe(false);
  });

  it.each(ACCOUNT_ROLE_CASES.map((row) => [row.name, row] as const))(
    'answers as before: %s',
    (_name, row) => {
      const [guard] = appGuards(providers);
      if (!(guard instanceof RolesGuard)) throw new Error('no RolesGuard registered');
      const legacy = new RolesGuard(new Reflector());
      expect(decide(guard, row.handler, row.user)).toBe(row.allowed);
      expect(decide(guard, row.handler, row.user)).toBe(decide(legacy, row.handler, row.user));
    },
  );
});

describe('guardProvidersForEnrolment — a module-access entry', () => {
  const providers = guardProvidersForEnrolment({ service: 'hr-service', mode: 'module-access' });

  it('registers the classification guard before RolesGuard', () => {
    const guards = appGuards(providers);
    expect(guards).toHaveLength(2);
    expect(guards[0]).toBeInstanceOf(AccessClassificationGuard);
    expect(guards[1]).toBeInstanceOf(RolesGuard);
  });

  it('denies an unclassified operation that account-role mode admits', () => {
    const [, roles] = appGuards(providers);
    if (!(roles instanceof RolesGuard)) throw new Error('no RolesGuard registered');
    expect(decide(roles, 'unclassified', member())).toBe(false);
    expect(decide(new RolesGuard(new Reflector()), 'unclassified', member())).toBe(true);
  });

  it('denies an @Access handler under a class-level @Public to a caller without its grant', () => {
    const context = graphqlContext(PublicClassResolver, 'payrolls', {
      method: 'POST',
      user: member({ roles: ['MODULE_USER'], moduleAccess: {} }),
    });
    const [classification, roles] = appGuards(providers);
    if (!(classification instanceof AccessClassificationGuard) || !(roles instanceof RolesGuard)) {
      throw new Error('the module-access guards are not registered in order');
    }
    expect(classification.canActivate(context)).toBe(true);
    expect(() => roles.canActivate(context)).toThrow(ForbiddenException);
  });

  it('labels @AccessCaller() denials with the service through MODULE_ACCESS_SERVICE', () => {
    const label = providers
      .filter(isFactoryProvider)
      .find((provider) => provider.provide === MODULE_ACCESS_SERVICE);
    if (label === undefined) throw new Error('no MODULE_ACCESS_SERVICE provider');
    expect(label.useFactory()).toBe('hr-service');
    expect(moduleAccessServiceLabel()).toBe('hr-service');
  });
});
