/**
 * ADR-051 access matrix, run against a deployed stack under today's enrolment (ADR-054 draft
 * D-H, its rollout PR-1; ADR-051 Enforcement, PKG-41).
 *
 * WHAT: every cell of MODULE_ACCESS_EXPECTED_CELLS (module-access-layers.expected.ts): each
 * characterized root operation × each ADR-051 §4 viewer, sent through the gateway with that
 * viewer's token, must show the outcome recorded as TODAY's, holes included (`open-today`). A
 * cell expecting FORBIDDEN passes only on a FORBIDDEN answer (HTTP 403 or a GraphQL error whose
 * code is FORBIDDEN); a cell expecting `allowed`, scoped or not, passes on any answer that is not
 * a denial and not an authentication failure (the operation ran: data, or a not-found error for
 * the random ids these requests carry). Scope narrowing is not observable from an empty tenant;
 * the recorded scope is checked in CI by tests/invariants/module-access-characterization.spec.ts.
 *
 * WHERE IT RUNS: a seeded stack only. No CI workflow brings one up today (the Playwright
 * `security` project runs in no workflow; e2e-messaging boots one service against Postgres and
 * Redis), so this spec is not wired into CI. The recorded cells are checked on every PR by the
 * characterization invariant, from the code; this spec checks the same cells against the running
 * system. It needs:
 *   - GATEWAY_URL: the gateway (default http://localhost:4000, playwright.config.ts);
 *   - E2E_JWT_PRIVATE_KEY_FILE: the RS256 private key whose public half the stack verifies with
 *     (the platform is RS256-only, tests/invariants/jwt-rs256-only.spec.ts, so the suite's HS256
 *     helper tokens cannot authenticate);
 *   - E2E_MATRIX_TENANT_ID: an active tenant of that stack;
 *   - optionally E2E_JWT_ISSUER and E2E_JWT_AUDIENCE (default aquaculture-platform, as
 *     helpers/jwt.helper.ts).
 * Without them the suite fails at its first test and says which is missing: a matrix that cannot
 * observe the system must not pass.
 *
 * Each viewer's token carries exactly the §4 viewer's `roles`, `moduleAccess` and capabilities
 * (module-access-layers.matrix.ts), shaped as auth-service mints it.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import jwt from 'jsonwebtoken';

import { MODULE_ACCESS_EXPECTED_CELLS } from './module-access-layers.expected';
import {
  CHARACTERIZED_OPERATIONS,
  MODULE_ACCESS_VIEWERS,
  type CellOutcome,
  type CharacterizedOperation,
  type MatrixViewer,
} from './module-access-layers.matrix';

interface LiveConfig {
  readonly privateKey: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly audience: string;
}

function liveConfig(): LiveConfig {
  const keyFile = process.env['E2E_JWT_PRIVATE_KEY_FILE'];
  const tenantId = process.env['E2E_MATRIX_TENANT_ID'];
  const missing = [
    keyFile === undefined ? 'E2E_JWT_PRIVATE_KEY_FILE' : null,
    tenantId === undefined ? 'E2E_MATRIX_TENANT_ID' : null,
  ].filter((name): name is string => name !== null);
  if (keyFile === undefined || tenantId === undefined) {
    throw new Error(
      `module-access-layers.spec.ts needs a seeded stack: set ${missing.join(' and ')} ` +
        '(see the header). It does not run in CI; the characterization invariant does.',
    );
  }
  return {
    privateKey: readFileSync(keyFile, 'utf8'),
    tenantId,
    issuer: process.env['E2E_JWT_ISSUER'] ?? 'aquaculture-platform',
    audience: process.env['E2E_JWT_AUDIENCE'] ?? 'aquaculture-platform',
  };
}

function viewerToken(viewer: MatrixViewer, config: LiveConfig): string {
  const role = viewer.roles[0] ?? 'MODULE_USER';
  const userId = randomUUID();
  return jwt.sign(
    {
      sub: userId,
      email: `matrix-${viewer.id}-${userId.slice(0, 8)}@test.aquaculture.io`,
      role,
      roles: [...viewer.roles],
      tenantId: config.tenantId,
      modules: Object.keys(viewer.moduleAccess),
      moduleAccess: viewer.moduleAccess,
      resourcePermissions: [...viewer.capabilities],
      assignedSiteIds: [...viewer.assignedSiteIds],
      type: 'access',
      jti: randomUUID(),
    },
    config.privateKey,
    { algorithm: 'RS256', expiresIn: '10m', issuer: config.issuer, audience: config.audience },
  );
}

type Observed = 'FORBIDDEN' | 'allowed' | 'unauthenticated';

interface GraphQLBody {
  readonly errors?: ReadonlyArray<{
    readonly message?: string;
    readonly extensions?: { readonly code?: unknown };
  }>;
}

function observedOf(status: number, body: GraphQLBody | null): Observed {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'FORBIDDEN';
  const codes = (body?.errors ?? []).map((error) => error.extensions?.code);
  if (codes.includes('UNAUTHENTICATED')) return 'unauthenticated';
  if (codes.includes('FORBIDDEN')) return 'FORBIDDEN';
  return 'allowed';
}

async function send(
  request: APIRequestContext,
  operation: CharacterizedOperation,
  token: string,
  config: LiveConfig,
): Promise<{ status: number; body: GraphQLBody | null }> {
  const headers = { Authorization: `Bearer ${token}`, 'x-tenant-id': config.tenantId };
  const response =
    'graphql' in operation.request
      ? await request.post('/graphql', {
          headers,
          data: { query: operation.request.graphql, variables: operation.request.variables ?? {} },
        })
      : await request.post(operation.request.rest.path, {
          headers,
          // A path inside the caller's own tenant prefix: the one check the route makes today.
          data: { path: `${config.tenantId}/batch-document/matrix/matrix.pdf`, expirySeconds: 60 },
        });
  const text = await response.text();
  let body: GraphQLBody | null = null;
  try {
    body = JSON.parse(text) as GraphQLBody;
  } catch {
    body = null;
  }
  return { status: response.status(), body };
}

function expectedObservation(outcome: CellOutcome): Observed {
  return outcome === 'FORBIDDEN' ? 'FORBIDDEN' : 'allowed';
}

test.describe('ADR-051 access matrix under today’s enrolment (characterization)', () => {
  for (const operation of CHARACTERIZED_OPERATIONS) {
    for (const viewer of MODULE_ACCESS_VIEWERS) {
      const cell = MODULE_ACCESS_EXPECTED_CELLS[operation.id]?.[viewer.id];
      test(`${operation.id} as ${viewer.id}: ${cell?.today ?? '?'} (${cell?.status ?? '?'})`, async ({
        request,
      }) => {
        expect(cell, `no recorded cell for ${operation.id} × ${viewer.id}`).toBeDefined();
        if (cell === undefined) return;
        const config = liveConfig();
        const { status, body } = await send(
          request,
          operation,
          viewerToken(viewer, config),
          config,
        );
        expect(
          observedOf(status, body),
          `${operation.id} as ${viewer.id}: HTTP ${status} ${JSON.stringify(body?.errors ?? [])}`,
        ).toBe(expectedObservation(cell.today));
      });
    }
  }
});
