/**
 * Invariant: a global-schema RLS service that registers event-bus handlers
 * binds `TenantEventHandlerScope` on the bus.
 *
 * A NATS handler runs with no HTTP request behind it, so `TenantContextMiddleware`
 * never ran and the pg pool's RLS checkout patch reads an empty frame:
 * `app.current_tenant` stays unset and a write to a row-level-security table is
 * refused. notification-service's TaskOverdue handler failed that way on every
 * redelivery, 8 times a minute (PLAT-HIGH-936). The bus is the one place every
 * handler and the dead-letter record of its event pass through, so the scope is
 * bound there once (`EventBusModule.forRootAsync({ handlerScope })`) instead of
 * each handler wrapping itself and a forgotten one failing only at runtime.
 *
 * Scope: `apps/<app>/src/app.module.ts` that registers the bus AND the RLS pool
 * patch (`RlsModule.forPoolService`) but NOT `TenantConnectionBootstrap` (these
 * are the global-schema services: no search_path routing, the tenant lives in a
 * column) AND whose app has at least one bus handler. Schema-per-tenant services
 * route every handler through `withTenantContext` / `runInTenantTransaction`
 * themselves and are covered by `non-http-entrypoint-tenant-context.spec.ts`.
 *
 * Three services have handlers and no scope yet; they are held as known gaps
 * under PLAT-HIGH-937, and the spec fails when one is bound without leaving the
 * list, so the ratchet only tightens.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** App -> the tracked finding that owns the gap. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  'admin-api-service': 'PLAT-HIGH-937',
  'auth-service': 'PLAT-HIGH-937',
  'billing-service': 'PLAT-HIGH-937',
};

const HANDLER_MARKER = /subscribeWildcard\(|@SubscribeTo\(|@EventHandler\(/;

interface AppFacts {
  readonly app: string;
  readonly usesBus: boolean;
  readonly usesRlsPool: boolean;
  readonly usesSchemaRouting: boolean;
  readonly bindsScope: boolean;
  readonly hasHandlers: boolean;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function factsOf(app: string, files: readonly string[]): AppFacts {
  const moduleFile = `apps/${app}/src/app.module.ts`;
  const sourceFile = ts.createSourceFile(
    moduleFile,
    readFileSync(path.join(REPO_ROOT, moduleFile), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let usesBus = false;
  let usesRlsPool = false;
  let usesSchemaRouting = false;
  let bindsScope = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(target) && target.text === 'EventBusModule' && /^forRoot/.test(method)) {
        usesBus = true;
      }
      if (ts.isIdentifier(target) && target.text === 'RlsModule' && method === 'forPoolService') {
        usesRlsPool = true;
      }
    }
    if (ts.isIdentifier(node) && /TenantConnectionBootstrap/.test(node.text)) {
      usesSchemaRouting = true;
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'handlerScope' &&
      /TenantEventHandlerScope/.test(node.initializer.getText(sourceFile))
    ) {
      bindsScope = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const hasHandlers = files
    .filter(
      (file) =>
        file.startsWith(`apps/${app}/src/`) &&
        file.endsWith('.ts') &&
        !/(\.spec\.ts|__tests__|\.test\.ts)/.test(file),
    )
    .some((file) => HANDLER_MARKER.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')));

  return { app, usesBus, usesRlsPool, usesSchemaRouting, bindsScope, hasHandlers };
}

describe('global-schema RLS services bind TenantEventHandlerScope on the event bus', () => {
  const files = trackedFiles();
  const apps = files
    .filter((file) => /^apps\/[^/]+\/src\/app\.module\.ts$/.test(file))
    .map((file) => factsOf(file.split('/')[1] ?? file, files));
  const inScope = apps.filter(
    (facts) => facts.usesBus && facts.usesRlsPool && !facts.usesSchemaRouting && facts.hasHandlers,
  );

  it('finds the services it is meant to police', () => {
    // A guard that matches nothing passes forever: pin that the scan sees the
    // global-schema RLS services known to register handlers.
    expect(inScope.map((facts) => facts.app)).toEqual(
      expect.arrayContaining(['notification-service', 'billing-service', 'auth-service']),
    );
  });

  it('notification-service binds the scope (PLAT-HIGH-936)', () => {
    const notification = inScope.find((facts) => facts.app === 'notification-service');

    expect(notification?.bindsScope).toBe(true);
  });

  it('every other in-scope service is bound or a tracked known gap', () => {
    const unbound = inScope.filter((facts) => !facts.bindsScope).map((facts) => facts.app);

    expect(unbound.filter((app) => !(app in KNOWN_GAPS))).toEqual([]);
  });

  it('a known gap is still a gap (no stale entries: bind the scope, then delete the entry)', () => {
    const stillUnbound = new Set(
      inScope.filter((facts) => !facts.bindsScope).map((facts) => facts.app),
    );

    expect(Object.keys(KNOWN_GAPS).filter((app) => !stillUnbound.has(app))).toEqual([]);
  });
});
