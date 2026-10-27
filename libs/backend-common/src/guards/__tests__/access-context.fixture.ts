import type { ExecutionContext, Type } from '@nestjs/common';
import { Controller, Get, Post } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Mutation, Query, Resolver } from '@nestjs/graphql';

import { Access } from '../../decorators/access.decorator';
import { Public, Role, Roles } from '../../decorators/roles.decorator';

/**
 * Handlers and execution contexts for the ADR-051 guard specs (PKG-05). The contexts are Nest's
 * own ExecutionContextHost, so GqlExecutionContext and switchToHttp read them as in a request.
 */

/** One verified user as the subgraph middleware rebuilds it on `req.user`. */
export type FixtureUser = Readonly<Record<string, unknown>>;

export const TENANT = '11111111-1111-4111-8111-111111111111';

export function member(overrides: Record<string, unknown> = {}): FixtureUser {
  return {
    sub: 'user-1',
    tenantId: TENANT,
    roles: ['MODULE_USER'],
    moduleAccess: {},
    ...overrides,
  };
}

@Resolver()
export class FixtureResolver {
  @Query(() => String)
  unclassified(): string {
    return 'unclassified';
  }

  @Public()
  @Query(() => String)
  health(): string {
    return 'health';
  }

  /** hr-service payrolls: RBAC-HIGH-031's example of a requirement written for one module. */
  @Access.module('hr')
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => String)
  payrolls(): string {
    return 'payrolls';
  }

  /** farm's archiveFinanceCategory is gated to TENANT_ADMIN alone (ADR-051 §1). */
  @Access.module('farm')
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => String)
  archiveFinanceCategory(): string {
    return 'archived';
  }

  @Access.module('farm')
  @Roles(Role.MODULE_USER)
  @Query(() => String)
  batches(): string {
    return 'batches';
  }

  @Access.module('farm')
  @Roles(Role.MODULE_MANAGER)
  @Mutation(() => String)
  closeBatch(): string {
    return 'closed';
  }

  @Access.module('sensor')
  @Query(() => String)
  sensors(): string {
    return 'sensors';
  }

  @Access.scoped('workforce')
  @Query(() => String)
  employees(): string {
    return 'employees';
  }

  @Access.self()
  @Query(() => String)
  myProfile(): string {
    return 'me';
  }

  @Access.self()
  @Roles(Role.MODULE_USER)
  @Query(() => String)
  myProfileWithRoles(): string {
    return 'me';
  }

  @Access.company()
  @Query(() => String)
  companyTree(): string {
    return 'tree';
  }

  @Access.company()
  @Mutation(() => String)
  renameCompany(): string {
    return 'renamed';
  }

  @Access.account('roles:create')
  @Mutation(() => String)
  createTenantRole(): string {
    return 'created';
  }

  @Query(() => String)
  noRoles(): string {
    return 'open';
  }

  @Roles(Role.TENANT_ADMIN)
  @Query(() => String)
  adminOnly(): string {
    return 'admin';
  }

  @Roles(Role.MODULE_USER)
  @Query(() => String)
  moduleUserOrHigher(): string {
    return 'user';
  }

  @Roles(Role.MODULE_MANAGER)
  @Query(() => String)
  managerOrHigher(): string {
    return 'manager';
  }
}

/** A class-level spec, overridden by one handler. */
@Access.module('sensor')
@Resolver()
export class SensorClassResolver {
  @Query(() => String)
  readings(): string {
    return 'readings';
  }

  @Access.module('farm')
  @Query(() => String)
  farmOverride(): string {
    return 'farm';
  }
}

@Controller('fixture')
export class FixtureController {
  @Access.company()
  @Get()
  read(): string {
    return 'read';
  }

  @Access.company()
  @Post()
  write(): string {
    return 'write';
  }

  @Get('open')
  unclassified(): string {
    return 'open';
  }
}

/** A GraphQL root-field context of `type.name` whose `req` is `request`. */
export function graphqlContext(
  type: Type<unknown>,
  name: string,
  request: object,
): ExecutionContext {
  const handler: unknown = Reflect.get(type.prototype, name);
  if (typeof handler !== 'function') throw new Error(`${type.name}.${name} is no handler`);
  const host = new ExecutionContextHost([undefined, {}, { req: request }, {}], type, handler);
  host.setType('graphql');
  return host;
}

/** A REST handler context of `type.name` whose request is `request`. */
export function httpContext(type: Type<unknown>, name: string, request: object): ExecutionContext {
  const handler: unknown = Reflect.get(type.prototype, name);
  if (typeof handler !== 'function') throw new Error(`${type.name}.${name} is no handler`);
  const host = new ExecutionContextHost([request, {}, () => undefined], type, handler);
  host.setType('http');
  return host;
}
