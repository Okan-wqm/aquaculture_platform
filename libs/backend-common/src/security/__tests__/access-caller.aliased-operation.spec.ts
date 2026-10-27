import { ApolloFederationDriver, type ApolloFederationDriverConfig } from '@nestjs/apollo';
import {
  Module,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  Directive,
  Field,
  GraphQLModule,
  ID,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
} from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';

import { AccessCaller } from '../../decorators/access-caller.decorator';
import { Access } from '../../decorators/access.decorator';
import { Role, Roles } from '../../decorators/roles.decorator';
import { guardProvidersForEnrolment } from '../../guards/access-guard-providers';
import { isAccessCaller } from '../access-caller';

/**
 * ADR-051 §3 on a real Nest GraphQL subgraph (RBAC-HIGH-030, RBAC-HIGH-031; plan PKG-05,
 * access-caller.aliased-operation.spec.ts). The service is enrolled `module-access` through the
 * same provider builder `accessGuardProviders` uses, so the classification guard and RolesGuard
 * are the APP_GUARDs a service would run.
 *
 *   - One operation aliasing root fields with different specs: each AccessCaller holds only its
 *     own field's scope, and a denied sibling does not change the others.
 *   - A reference resolver and a field resolver run no guard, and still deny with FORBIDDEN,
 *     because `@AccessCaller()` decides there.
 *   - A handler without `@Access` is denied (root field by the guard, field resolver by
 *     `@AccessCaller()`); a malformed claim is BAD_REQUEST.
 */

@ObjectType()
@Directive('@key(fields: "id")')
class Widget {
  @Field(() => ID)
  id!: string;

  @Field()
  note!: string;
}

function scopeText(caller: AccessCaller): string {
  if (!isAccessCaller(caller)) throw new Error('not a decided caller');
  const scope = caller.moduleScope;
  if (scope === null) return 'none';
  return scope.kind === 'all' ? 'all' : scope.modules.join(',');
}

/** Handler names every APP_GUARD invocation saw, in order. */
const guardedHandlers: string[] = [];

class RecordingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    guardedHandlers.push(context.getHandler().name);
    return true;
  }
}

@Resolver(() => Widget)
class WidgetResolver {
  @Access.module('sensor')
  @Query(() => String, { nullable: true })
  sensorScope(@AccessCaller() caller: AccessCaller): string {
    return scopeText(caller);
  }

  @Access.scoped('common-registry')
  @Query(() => String, { nullable: true })
  registryScope(@AccessCaller() caller: AccessCaller): string {
    return scopeText(caller);
  }

  @Access.scoped('common-registry')
  @Roles(Role.MODULE_MANAGER)
  @Query(() => String, { nullable: true })
  managedRegistryScope(@AccessCaller() caller: AccessCaller): string {
    return scopeText(caller);
  }

  @Access.module('hr')
  @Query(() => String, { nullable: true })
  hrScope(@AccessCaller() caller: AccessCaller): string {
    return scopeText(caller);
  }

  @Query(() => String, { nullable: true })
  unclassified(): string {
    return 'reached';
  }

  @Access.company()
  @Mutation(() => String, { nullable: true })
  renameCompany(): string {
    return 'renamed';
  }

  @Access.module('sensor')
  @Query(() => Widget, { nullable: true })
  widget(): Widget {
    return { id: 'w1', note: 'root' };
  }

  @Access.module('farm')
  @ResolveReference()
  resolveReference(
    @Parent() reference: { readonly id: string },
    @AccessCaller() caller: AccessCaller,
  ): Widget {
    return { id: reference.id, note: scopeText(caller) };
  }

  @Access.module('hr')
  @ResolveField(() => String, { nullable: true })
  payroll(@Parent() widget: Widget, @AccessCaller() caller: AccessCaller): string {
    return `${widget.id}:${scopeText(caller)}`;
  }

  @ResolveField(() => String, { nullable: true })
  unannotated(@Parent() widget: Widget, @AccessCaller() caller: AccessCaller): string {
    return `${widget.id}:${scopeText(caller)}`;
  }

  @ResolveField(() => String)
  parentScoped(@Parent() widget: Widget): string {
    return `${widget.id}:parent`;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2 },
      playground: false,
      context: ({ req }: { readonly req: Request }): { readonly req: Request } => ({ req }),
    }),
  ],
  providers: [
    WidgetResolver,
    { provide: APP_GUARD, useValue: new RecordingGuard() },
    ...guardProvidersForEnrolment({ service: 'sensor-service', mode: 'module-access' }),
  ],
})
class SubgraphModule {}

/** The verified user the subgraph middleware would rebuild, sent by the test as a header. */
function testUser(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string') {
    const user: unknown = JSON.parse(header);
    Reflect.set(req, 'user', user);
  }
  next();
}

interface GraphqlError {
  readonly path?: readonly (string | number)[];
  readonly extensions?: { readonly code?: string };
}

interface GraphqlReply {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly GraphqlError[];
}

function isGraphqlReply(value: unknown): value is GraphqlReply {
  return typeof value === 'object' && value !== null && ('data' in value || 'errors' in value);
}

const TENANT = '11111111-1111-4111-8111-111111111111';

function memberUser(overrides: Record<string, unknown>): string {
  return JSON.stringify({ sub: 'user-1', tenantId: TENANT, roles: ['MODULE_USER'], ...overrides });
}

function codeAt(reply: GraphqlReply, path: string): string | undefined {
  const error = (reply.errors ?? []).find((entry) => (entry.path ?? []).join('.') === path);
  return error === undefined || error.extensions === undefined ? undefined : error.extensions.code;
}

describe('@AccessCaller() on a module-access subgraph (ADR-051 §3)', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SubgraphModule] }).compile();
    app = moduleRef.createNestApplication<INestApplication<Server>>();
    app.use(testUser);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    guardedHandlers.length = 0;
  });

  async function send(
    user: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GraphqlReply> {
    const reply = await request(app.getHttpServer())
      .post('/graphql')
      .set('x-test-user', user)
      .send({ query, variables });
    const body: unknown = reply.body;
    if (!isGraphqlReply(body)) throw new Error('the subgraph answered no GraphQL reply');
    return body;
  }

  const farmManagerSensorUser = memberUser({
    moduleAccess: { farm: 'MODULE_MANAGER', sensor: 'MODULE_USER' },
  });

  it('gives each aliased root field only its own scope', async () => {
    const reply = await send(
      farmManagerSensorUser,
      '{ s: sensorScope r: registryScope m: managedRegistryScope h: hrScope s2: sensorScope }',
    );

    expect(reply.data).toEqual({ s: 'sensor', r: 'farm,sensor', m: 'farm', h: null, s2: 'sensor' });
    expect(codeAt(reply, 'h')).toBe('FORBIDDEN');
    expect(reply.errors).toHaveLength(1);
  });

  it('answers the same fields the same way in any alias order', async () => {
    const reply = await send(
      farmManagerSensorUser,
      '{ h: hrScope m: managedRegistryScope r: registryScope s: sensorScope }',
    );

    expect(reply.data).toEqual({ h: null, m: 'farm', r: 'farm,sensor', s: 'sensor' });
  });

  it('denies a root field without @Access, by the classification guard', async () => {
    const reply = await send(memberUser({ roles: ['TENANT_ADMIN'] }), '{ unclassified }');

    expect(reply.data).toEqual({ unclassified: null });
    expect(codeAt(reply, 'unclassified')).toBe('FORBIDDEN');
    expect(guardedHandlers).toContain('unclassified');
  });

  it('denies a Company write even to a holder of company:view', async () => {
    const reply = await send(
      memberUser({ resourcePermissions: ['company:view'] }),
      'mutation { renameCompany }',
    );

    expect(codeAt(reply, 'renameCompany')).toBe('FORBIDDEN');
  });

  const entities =
    'query ($r: [_Any!]!) { _entities(representations: $r) { ... on Widget { id note } } }';
  const representations = { r: [{ __typename: 'Widget', id: 'w7' }] };

  it('decides a reference resolver with no guard: allowed with the grant', async () => {
    const reply = await send(farmManagerSensorUser, entities, representations);

    expect(reply.errors).toBeUndefined();
    expect(reply.data).toEqual({ _entities: [{ id: 'w7', note: 'farm' }] });
    expect(guardedHandlers).not.toContain('resolveReference');
  });

  it('decides a reference resolver with no guard: FORBIDDEN without the grant', async () => {
    const reply = await send(
      memberUser({ moduleAccess: { sensor: 'MODULE_MANAGER' } }),
      entities,
      representations,
    );

    expect(codeAt(reply, '_entities.0')).toBe('FORBIDDEN');
    expect(guardedHandlers).not.toContain('resolveReference');
  });

  it('decides a field resolver with no guard: FORBIDDEN without the grant, the parent intact', async () => {
    const reply = await send(farmManagerSensorUser, '{ widget { id payroll parentScoped } }');

    expect(reply.data).toEqual({ widget: { id: 'w1', payroll: null, parentScoped: 'w1:parent' } });
    expect(codeAt(reply, 'widget.payroll')).toBe('FORBIDDEN');
    expect(guardedHandlers).toEqual(['widget']);
  });

  it('allows the field resolver to a caller holding its module', async () => {
    const reply = await send(
      memberUser({ moduleAccess: { sensor: 'MODULE_USER', hr: 'MODULE_USER' } }),
      '{ widget { payroll } }',
    );

    expect(reply.data).toEqual({ widget: { payroll: 'w1:hr' } });
  });

  it('denies a field resolver that declares no @Access, whoever asks', async () => {
    const reply = await send(
      memberUser({ roles: ['TENANT_ADMIN'], moduleAccess: { sensor: 'MODULE_MANAGER' } }),
      '{ widget { unannotated } }',
    );

    expect(reply.data).toEqual({ widget: { unannotated: null } });
    expect(codeAt(reply, 'widget.unannotated')).toBe('FORBIDDEN');
  });

  it('answers a malformed moduleAccess claim with BAD_REQUEST', async () => {
    const reply = await send(
      memberUser({ moduleAccess: { sensor: 'TENANT_ADMIN' } }),
      '{ sensorScope }',
    );

    expect(codeAt(reply, 'sensorScope')).toBe('BAD_REQUEST');
  });
});
