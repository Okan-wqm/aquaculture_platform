import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIResponse,
  type Page,
  type Response as BrowserResponse,
} from '@playwright/test';

import {
  decodeAdminHttpEnvelopeV1,
  decodeAdminHttpErrorEnvelopeV1,
} from '../../../platform/libs/admin-http-contracts/src';
import {
  E2E_SUPER_ADMIN_EMAIL,
  E2E_TENANT_ADMIN_EMAIL,
  E2E_TEST_PASSWORD,
} from '../../fixtures/platform-admin-credentials.fixture';

import composition from './platform-admin-composition.generated.json';

interface CompiledApiRoute {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly networkAliases: readonly string[];
  readonly successStatusCode: number;
  readonly authorization: {
    readonly authentication: string;
    readonly requiredRoles: readonly string[];
    readonly requiredPermissions: readonly string[];
    readonly permissionMode: string;
  };
  readonly responseKind: string;
}

function requiredObject(value: unknown, context: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function requiredProperty(value: unknown, name: string, context: string): unknown {
  const target = requiredObject(value, context);
  const result: unknown = Reflect.get(target, name);
  if (result === undefined || result === null) {
    throw new Error(`${context}.${name} is missing`);
  }
  return result;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  return requiredString(process.env[name], `process.env.${name}`);
}

function bearerHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Request-ID': randomUUID(),
  };
}

function neutralNetworkPath(
  route: CompiledApiRoute,
  parameters: Readonly<Record<string, string>> = {},
): string {
  const neutral = route.networkAliases.find(
    (candidate) => candidate.startsWith('/api/') && !candidate.startsWith('/api/v1/'),
  );
  if (neutral === undefined) throw new Error(`${route.id} has no neutral /api alias`);
  let path = neutral;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  if (/:[A-Za-z_$][A-Za-z0-9_$]*/.test(path)) {
    throw new Error(`${route.id} has unresolved path parameters in ${path}`);
  }
  return path;
}

function isRouteResponse(
  response: BrowserResponse,
  route: CompiledApiRoute,
  parameters: Readonly<Record<string, string>> = {},
): boolean {
  return (
    response.request().method() === route.method &&
    new URL(response.url()).pathname === neutralNetworkPath(route, parameters)
  );
}

function isLoginResponse(response: BrowserResponse): boolean {
  if (
    response.request().method() !== 'POST' ||
    new URL(response.url()).pathname !== '/graphql'
  ) {
    return false;
  }
  return response.request().postData()?.includes('mutation Login(') === true;
}

async function realLogin(page: Page, email: string, expectedPath: string): Promise<string> {
  await page.goto('/login');
  const loginResponsePromise = page.waitForResponse(isLoginResponse);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(E2E_TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok()).toBe(true);
  const body: unknown = await loginResponse.json();
  const data = requiredProperty(body, 'data', 'login response');
  const login = requiredProperty(data, 'login', 'login response.data');
  const accessToken = requiredString(
    requiredProperty(login, 'accessToken', 'login response.data.login'),
    'login response.data.login.accessToken',
  );
  await expect(page).toHaveURL((url) => url.pathname === expectedPath);
  return accessToken;
}

function tenantIdentityFromList(data: unknown, tenantId: string): string {
  if (!Array.isArray(data)) throw new Error('tenant list data must be an array');
  const tenant = data.find(
    (entry) => requiredProperty(entry, 'id', 'tenant list item') === tenantId,
  );
  if (tenant === undefined) throw new Error(`seeded tenant ${tenantId} is absent from tenant list`);
  return requiredString(
    requiredProperty(tenant, 'name', 'seeded tenant list item'),
    'seeded tenant list item.name',
  );
}

async function expectErrorProjection(
  response: APIResponse,
  expectedStatus: number,
  expectedCode: string,
): Promise<void> {
  expect(response.status()).toBe(expectedStatus);
  const raw: unknown = await response.json();
  const envelope = decodeAdminHttpErrorEnvelopeV1(raw);
  expect(envelope.contractVersion).toBe(composition.flagshipJourney.wireContracts.error);
  expect(envelope.error.status).toBe(expectedStatus);
  expect(envelope.error.code).toBe(expectedCode);
  expect(response.headers()['x-request-id']).toBe(envelope.error.requestId);
}

function assertSuperAdminRoute(route: CompiledApiRoute): void {
  expect(route.authorization).toEqual({
    authentication: composition.panelAuthorization.authentication,
    requiredRoles: [composition.panelAuthorization.requiredRole],
    requiredPermissions: [],
    permissionMode: 'all',
  });
}

test.describe('generated platform-admin composition', () => {
  test.describe.configure({ mode: 'serial' });

  test('SUPER_ADMIN completes generated tenant list, detail, and note action journey', async ({
    page,
  }) => {
    const journey = composition.flagshipJourney;
    const listRoute: CompiledApiRoute = journey.list.api;
    const detailRoute: CompiledApiRoute = journey.detail.api;
    const actionRoute: CompiledApiRoute = journey.action.api;
    const cleanupRoute: CompiledApiRoute = journey.cleanup.api;
    for (const route of [listRoute, detailRoute, actionRoute, cleanupRoute]) {
      assertSuperAdminRoute(route);
    }

    const token = await realLogin(page, E2E_SUPER_ADMIN_EMAIL, '/admin');
    await expect(page.locator('a[href="#main-content"]')).toHaveText('Skip to main content');
    await expect(page.locator('main#main-content')).toBeAttached();
    await expect(page.getByText('Aqua Admin', { exact: true })).toBeVisible();

    await page
      .getByRole('button', { name: journey.navigation.groupLabel, exact: true })
      .click();
    const listResponsePromise = page.waitForResponse((response) =>
      isRouteResponse(response, listRoute),
    );
    await page
      .getByRole('button', { name: journey.navigation.leafLabel, exact: true })
      .click();
    const listResponse = await listResponsePromise;
    expect(listResponse.status()).toBe(listRoute.successStatusCode);
    const listRaw: unknown = await listResponse.json();
    expect(requiredProperty(listRaw, 'contractVersion', 'tenant list response')).toBe(
      journey.wireContracts.success,
    );
    const listEnvelope = decodeAdminHttpEnvelopeV1(listRaw);
    expect(Array.isArray(listEnvelope.data)).toBe(true);
    expect(listEnvelope.pagination).toBeDefined();
    expect(listEnvelope.pagination?.page).toBe(1);
    expect(listEnvelope.pagination?.limit).toBe(20);
    expect(listEnvelope.pagination?.totalPages).toBe(
      Math.max(1, Math.ceil((listEnvelope.pagination?.total ?? 0) / 20)),
    );
    expect(listResponse.headers()['x-request-id']).toBe(listEnvelope.requestId);
    await expect(page.getByRole('heading', { name: 'Tenant Management' })).toBeVisible();

    const tenantId = requiredEnvironment('E2E_TENANT_ID');
    const tenantName = tenantIdentityFromList(listEnvelope.data, tenantId);
    const tenantRow = page.getByRole('row').filter({ hasText: tenantName });
    await expect(tenantRow).toBeVisible();
    const detailResponsePromise = page.waitForResponse((response) =>
      isRouteResponse(response, detailRoute, { id: tenantId }),
    );
    await tenantRow.getByRole('button', { name: journey.list.rowActionLabel }).click();
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status()).toBe(detailRoute.successStatusCode);
    const detailRaw: unknown = await detailResponse.json();
    const detailEnvelope = decodeAdminHttpEnvelopeV1(detailRaw);
    expect(detailEnvelope.pagination).toBeUndefined();
    await expect(page).toHaveURL(
      (url) => url.pathname === journey.detail.page.path.replace(':tenantId', tenantId),
    );
    await expect(page.getByRole('heading', { name: tenantName })).toBeVisible();

    await page.getByRole('button', { name: journey.detail.tabLabel, exact: true }).click();
    await page.getByRole('button', { name: journey.action.openLabel, exact: true }).click();
    const noteText = `platform-admin-e2e-${randomUUID()}`;
    const noteDialog = page.getByRole('dialog', { name: journey.action.openLabel });
    await noteDialog.getByPlaceholder(journey.action.inputPlaceholder).fill(noteText);

    let createdNoteId: string | undefined;
    let deleted = false;
    try {
      const actionResponsePromise = page.waitForResponse((response) =>
        isRouteResponse(response, actionRoute, { id: tenantId }),
      );
      await noteDialog
        .getByRole('button', { name: journey.action.submitLabel, exact: true })
        .click();
      const actionResponse = await actionResponsePromise;
      expect(actionResponse.status()).toBe(actionRoute.successStatusCode);
      const actionRaw: unknown = await actionResponse.json();
      const actionEnvelope = decodeAdminHttpEnvelopeV1(actionRaw);
      createdNoteId = requiredString(
        requiredProperty(actionEnvelope.data, 'id', 'create-note response data'),
        'create-note response data.id',
      );
      await expect(page.getByText(noteText, { exact: true })).toBeVisible();

      const noteCard = page
        .getByText(noteText, { exact: true })
        .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
      const cleanupResponsePromise = page.waitForResponse((response) =>
        isRouteResponse(response, cleanupRoute, { id: tenantId, noteId: createdNoteId ?? '' }),
      );
      await noteCard
        .getByRole('button', { name: journey.cleanup.actionLabel, exact: true })
        .click();
      const cleanupResponse = await cleanupResponsePromise;
      expect(cleanupResponse.status()).toBe(cleanupRoute.successStatusCode);
      deleted = true;
      await expect(page.getByText(noteText, { exact: true })).toHaveCount(0);
    } finally {
      if (createdNoteId !== undefined && !deleted) {
        const cleanupResponse = await page.request.delete(
          neutralNetworkPath(cleanupRoute, { id: tenantId, noteId: createdNoteId }),
          { headers: bearerHeaders(token) },
        );
        expect([cleanupRoute.successStatusCode, 404]).toContain(cleanupResponse.status());
      }
    }

    const missingResponse = await page.request.get(
      neutralNetworkPath(detailRoute, { id: randomUUID() }),
      { headers: bearerHeaders(token) },
    );
    await expectErrorProjection(
      missingResponse,
      journey.errors.missingResourceStatus,
      journey.errors.missingResourceCode,
    );

    const unknownResponse = await page.request.get(journey.errors.unknownApiPath, {
      headers: bearerHeaders(token),
    });
    await expectErrorProjection(
      unknownResponse,
      journey.errors.unknownApiStatus,
      journey.errors.unknownApiCode,
    );
  });

  test('TENANT_ADMIN is denied by both shell composition and generated admin API policy', async ({
    page,
  }) => {
    const journey = composition.flagshipJourney;
    const listRoute: CompiledApiRoute = journey.list.api;
    const token = await realLogin(page, E2E_TENANT_ADMIN_EMAIL, '/tenant');

    await page.goto(journey.list.page.path);
    await expect(page).toHaveURL(
      (url) => url.pathname === journey.errors.unauthorizedBrowserPath,
    );
    await expect(
      page.getByRole('heading', { name: journey.errors.unauthorizedHeading }),
    ).toBeVisible();

    const response = await page.request.get(`${neutralNetworkPath(listRoute)}?page=1&limit=1`, {
      headers: bearerHeaders(token),
    });
    await expectErrorProjection(response, 403, 'FORBIDDEN');
  });
});
