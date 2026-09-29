/**
 * farm-service request scope stays inside GraphQL resolvers (UNVERIFIED boot
 * item of the B1a-1 verifier round).
 *
 * WHY: a REQUEST-scoped provider makes every provider whose dependency tree
 * reaches it request-scoped too, and Nest says nothing. On a GraphQL resolver
 * that is the intended DataLoader shape; on a cron service, an event handler
 * or a NATS controller it silently breaks boot behaviour (a request-scoped
 * @Cron never fires, a request-scoped message handler is rebuilt per message).
 * This PR added `SparePartStockDataLoader` (REQUEST) to `SparePartResolver` and
 * imported the storage module into the feed, chemical, consumable,
 * maintenance, site and seed modules. `di-graph.spec.ts` proves the graph
 * resolves; this spec proves its shape.
 *
 * WHAT: over the REAL AppModule graph (Nest preview: every constructor
 * dependency resolved, nothing constructed), every provider or controller
 * that is request-scoped only through its dependency tree must be a GraphQL
 * resolver with no scheduler hooks; the spare-part chain is exactly
 * `SparePartStockDataLoader` (REQUEST) → `SparePartResolver`.
 */
import { Scope } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { RESOLVER_NAME_METADATA, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';
import {
  SCHEDULE_CRON_OPTIONS,
  SCHEDULE_INTERVAL_OPTIONS,
  SCHEDULE_TIMEOUT_OPTIONS,
} from '@nestjs/schedule/dist/schedule.constants';
import { inspectNestGraph } from '@platform/testing';

import { AppModule } from '../app.module';

interface ScopedNode {
  module: string;
  name: string;
  explicitRequest: boolean;
  isController: boolean;
  isResolver: boolean;
  hasSchedulerHook: boolean;
}

/** Every provider/controller whose dependency tree is request-scoped. */
function requestScoped(modules: ModulesContainer): ScopedNode[] {
  const nodes: ScopedNode[] = [];
  for (const module of modules.values()) {
    const moduleName = module.metatype?.name ?? 'unknown';
    // Nest's own REQUEST token lives here; it is the root of every request chain.
    if (moduleName === 'InternalCoreModule') continue;
    const entries = [
      ...[...module.providers.values()].map((wrapper) => ({ wrapper, isController: false })),
      ...[...module.controllers.values()].map((wrapper) => ({ wrapper, isController: true })),
    ];
    for (const { wrapper, isController } of entries) {
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function' || wrapper.isDependencyTreeStatic()) continue;
      const prototype: object = metatype.prototype ?? {};
      const methods = Object.getOwnPropertyNames(prototype).map(
        (key) => Object.getOwnPropertyDescriptor(prototype, key)?.value,
      );
      nodes.push({
        module: moduleName,
        name: String(wrapper.name),
        explicitRequest: wrapper.scope === Scope.REQUEST,
        isController,
        isResolver:
          Reflect.getMetadata(RESOLVER_TYPE_METADATA, metatype) !== undefined ||
          Reflect.getMetadata(RESOLVER_NAME_METADATA, metatype) !== undefined,
        hasSchedulerHook: methods.some(
          (method) =>
            typeof method === 'function' &&
            [SCHEDULE_CRON_OPTIONS, SCHEDULE_INTERVAL_OPTIONS, SCHEDULE_TIMEOUT_OPTIONS].some(
              (key) => Reflect.getMetadata(key, method) !== undefined,
            ),
        ),
      });
    }
  }
  return nodes;
}

describe('farm-service request scope', () => {
  it('reaches only GraphQL resolvers, and the spare-part loader only its resolver', async () => {
    // SCENARIO: the real AppModule graph. EXPECTS: every implicitly request-scoped
    // node is a resolver (no controller, no cron/interval/timeout); the spare-part
    // DataLoader is REQUEST and SparePartResolver is its only dependent.
    const nodes = await inspectNestGraph(AppModule, requestScoped);
    const implicit = nodes.filter((node) => !node.explicitRequest);

    expect(implicit.filter((node) => !node.isResolver || node.isController)).toEqual([]);
    expect(implicit.filter((node) => node.hasSchedulerHook)).toEqual([]);
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: 'MaintenanceModule',
          name: 'SparePartStockDataLoader',
          explicitRequest: true,
        }),
        expect.objectContaining({
          module: 'MaintenanceModule',
          name: 'SparePartResolver',
          explicitRequest: false,
          isResolver: true,
        }),
      ]),
    );
    expect(
      implicit.filter((node) => node.module === 'MaintenanceModule').map((node) => node.name),
    ).toEqual(['SparePartResolver']);
  }, 120_000);
});
