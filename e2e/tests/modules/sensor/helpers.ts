/**
 * Sensor E2E Test Helpers
 *
 * GraphQL client, tenant context factories, and shared utilities
 * for sensor-service E2E tests.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export const GW_URL = process.env.E2E_GATEWAY_URL || 'http://localhost:4000/graphql';

export const TENANT_A = {
  id: process.env.E2E_TENANT_A_ID || '11111111-1111-1111-1111-111111111111',
  token: process.env.E2E_TENANT_A_TOKEN || 'e2e-token-tenant-a',
};

export const TENANT_B = {
  id: process.env.E2E_TENANT_B_ID || '22222222-2222-2222-2222-222222222222',
  token: process.env.E2E_TENANT_B_TOKEN || 'e2e-token-tenant-b',
};

// ============================================================================
// GraphQL Client
// ============================================================================

export interface GqlResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

/**
 * Execute a GraphQL operation against the gateway.
 * Injects tenant authorization headers.
 */
export async function gql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  tenant: { id: string; token: string } = TENANT_A,
): Promise<GqlResponse<T>> {
  const res = await fetch(GW_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenant.token}`,
      'x-tenant-id': tenant.id,
    },
    body: JSON.stringify({ query, variables }),
  });

  return res.json() as Promise<GqlResponse<T>>;
}

// ============================================================================
// Unique ID generators
// ============================================================================

let counter = 0;

export function uniqueSerial(prefix = 'SN'): string {
  counter++;
  return `${prefix}-E2E-${Date.now()}-${counter}`;
}

export function uniqueName(prefix = 'E2E'): string {
  counter++;
  return `${prefix}-${Date.now()}-${counter}`;
}

export function uniqueCode(prefix = 'EDGE'): string {
  counter++;
  return `${prefix}-${Date.now()}-${counter}`;
}

// ============================================================================
// DB verification helper
// ============================================================================

/**
 * Direct database query for verification.
 * Uses the sensor-service database connection.
 */
export function dbQuery(sql: string, params: unknown[] = []): Promise<unknown[]> {
  // In a real E2E setup, this would connect to the test database.
  // Verification currently goes through GraphQL queries (double-read pattern).
  // This function exists as a placeholder for DB-level assertions.
  // The body has no awaited work yet, so it is synchronous; it returns a
  // resolved Promise to preserve the awaitable DB-helper contract for callers.
  void sql;
  void params;
  return Promise.resolve([]);
}

// ============================================================================
// Cleanup tracker
// ============================================================================

const cleanupStack: Array<() => Promise<void>> = [];

export function onCleanup(fn: () => Promise<void>): void {
  cleanupStack.push(fn);
}

export async function runCleanup(): Promise<void> {
  while (cleanupStack.length) {
    const fn = cleanupStack.pop();
    if (fn) {
      try {
        await fn();
      } catch {
        // Cleanup failures are non-fatal in E2E
      }
    }
  }
}
