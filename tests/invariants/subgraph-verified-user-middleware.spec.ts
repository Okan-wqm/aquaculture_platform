/**
 * Invariant: every GraphQL subgraph resolves the caller from the gateway-signed
 * verified-user assertion.
 *
 * The gateway authenticates the user and signs a verified-user assertion for the
 * subgraph (`x-verified-user-assertion`). A subgraph turns it into `req.user` /
 * `req.tenantId` with `VerifiedUserAssertionMiddleware`; the global TenantGuard
 * then insists on that user ("No verified user reached the tenant guard"). A
 * subgraph that registers the guards but not the middleware therefore answers
 * EVERY authenticated operation with UNAUTHENTICATED even for a valid session.
 *
 * notification-service was that subgraph: `unreadNotificationCount`, the
 * notification list and mark-read all failed for every user, and since the web
 * client reads an UNAUTHENTICATED answer as "the access token expired" it spent
 * one `refreshToken` call per page load on it — the call that, at 10 per 5
 * minutes per IP, logged a whole office out. Nothing in any unit spec could see
 * it: the guard and the middleware are each correct alone.
 *
 * Scope: `apps/<app>/src/app.module.ts` that registers a GraphQLModule. The
 * middleware must be REGISTERED after StripInternalHeadersMiddleware (which
 * establishes the verified service identity the assertion is checked against) —
 * in the same `consumer.apply(...)` or in an earlier one: Nest runs middleware
 * in registration order.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A GraphQL app that is deliberately NOT a verified-user subgraph, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  'gateway-api':
    'it is the gateway: it authenticates the user and SIGNS the assertion the subgraphs verify',
  'auth-service':
    'it issues and refreshes the sessions (login, refresh, MFA): its callers hold no access token yet, ' +
    'so it resolves identity through its own pre-auth frame',
};

interface AppModuleFacts {
  readonly hasGraphqlModule: boolean;
  /** Identifier names of each `<x>.apply(...)` call, in argument order. */
  readonly applyChains: readonly string[][];
}

function appModuleFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /^apps\/[^/]+\/src\/app\.module\.ts$/.test(file));
}

function factsOf(file: string): AppModuleFacts {
  const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let hasGraphqlModule = false;
  const applyChains: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'GraphQLModule') hasGraphqlModule = true;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'apply'
    ) {
      applyChains.push(node.arguments.filter(ts.isIdentifier).map((identifier) => identifier.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { hasGraphqlModule, applyChains };
}

describe('every GraphQL subgraph applies VerifiedUserAssertionMiddleware', () => {
  const apps = appModuleFiles().map((file) => ({
    app: file.split('/')[1] ?? file,
    ...factsOf(file),
  }));
  const graphqlApps = apps.filter((entry) => entry.hasGraphqlModule);

  it('finds the subgraphs it is meant to police', () => {
    // A guard that matches nothing passes forever: pin that the scan sees the
    // services known to expose GraphQL.
    expect(graphqlApps.map((entry) => entry.app)).toEqual(
      expect.arrayContaining([
        'farm-service',
        'notification-service',
        'alert-engine',
        'hr-service',
      ]),
    );
  });

  it.each(
    graphqlApps
      .filter((entry) => !(entry.app in EXEMPT))
      .map((entry) => [entry.app, entry] as const),
  )(
    '%s registers VerifiedUserAssertionMiddleware after StripInternalHeadersMiddleware',
    (_app, entry) => {
      const registered = entry.applyChains.flat();
      const strip = registered.indexOf('StripInternalHeadersMiddleware');
      const verified = registered.indexOf('VerifiedUserAssertionMiddleware');

      expect(verified).toBeGreaterThanOrEqual(0); // never registered: every operation is UNAUTHENTICATED
      expect(strip).toBeGreaterThanOrEqual(0);
      expect(strip).toBeLessThan(verified); // the assertion is checked against the identity Strip verifies
    },
  );

  it('every exemption names an app that exists and still exposes GraphQL (no stale exemptions)', () => {
    for (const app of Object.keys(EXEMPT)) {
      expect(graphqlApps.map((entry) => entry.app)).toContain(app);
    }
  });
});
