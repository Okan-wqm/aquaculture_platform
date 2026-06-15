import { expect, test, type Page } from '@playwright/test';

const SMOKE_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SMOKE_USER_ID = '22222222-2222-4222-8222-222222222222';

function expectsRemoteEntry(): boolean {
  return process.env.FARM_WATER_CHEMISTRY_EXPECT_REMOTE_ENTRY !== 'false';
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSmokeAccessToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: 'none', typ: 'JWT' }),
    base64UrlJson({
      exp: now + 3600,
      iat: now,
      sub: SMOKE_USER_ID,
      tenantId: SMOKE_TENANT_ID,
      role: 'MODULE_USER',
    }),
    'smoke-signature',
  ].join('.');
}

async function installShellAuthMocks(page: Page): Promise<void> {
  const accessToken = createSmokeAccessToken();
  const user = {
    id: SMOKE_USER_ID,
    email: 'water-chemistry-smoke@example.test',
    firstName: 'Water',
    lastName: 'Chemistry',
    role: 'MODULE_USER',
    tenantId: SMOKE_TENANT_ID,
    accessType: 'BOTH',
    isActive: true,
  };

  await page.addInitScript((tenantId) => {
    window.localStorage.setItem('tenant_id', tenantId);
  }, SMOKE_TENANT_ID);

  await page.route('**/graphql', async (route) => {
    const requestBody = route.request().postData() ?? '{}';
    let query = '';
    try {
      const parsed = JSON.parse(requestBody) as { query?: unknown };
      query = typeof parsed.query === 'string' ? parsed.query : '';
    } catch {
      query = '';
    }

    if (query.includes('refreshToken')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            refreshToken: {
              accessToken,
              user: {
                id: user.id,
                email: user.email,
                role: user.role,
                tenantId: user.tenantId,
              },
            },
          },
        }),
      });
      return;
    }

    if (/\bme\s*\{/.test(query)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            me: {
              user,
              modules: [
                {
                  code: 'farm',
                  name: 'Sites',
                  defaultRoute: '/sites',
                },
              ],
              redirectPath: '/sites/water-chemistry',
            },
          },
        }),
      });
      return;
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: {} }),
    });
  });
}

test('Deffeyes ALK/DIC chart, report print, and CSP stay release-safe', async ({ page }) => {
  const cspMessages: string[] = [];
  const pageErrors: string[] = [];
  const remoteEntryRequests: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|violat/i.test(text)) {
      cspMessages.push(text);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/remotes/farm-module/remoteEntry.js') {
      remoteEntryRequests.push(request.url());
    }
  });

  await installShellAuthMocks(page);
  await page.goto('');

  // Single ALK/DIC Deffeyes chart — the DIC/pH chart was removed (legacy is the only mode).
  await expect(page.getByTestId('deffeyes-ph-chart')).toHaveCount(0);
  await expect(page.getByText('Water Quality Management Chart').first()).toBeVisible();

  if (expectsRemoteEntry()) {
    expect(remoteEntryRequests.length).toBeGreaterThan(0);
  }

  await page.getByRole('button', { name: /print report/i }).click();
  const reportFrame = page.locator('iframe[title="Water Chemistry Report"]');
  await expect(reportFrame).toBeAttached();
  const reportHtml = await reportFrame.evaluate((element) => {
    const frame = element as HTMLIFrameElement;
    return frame.contentDocument?.documentElement.outerHTML ?? '';
  });

  expect(reportHtml).toContain('Water Chemistry Report');
  expect(reportHtml.toLowerCase()).not.toContain('<script');
  expect(reportHtml).not.toMatch(/pH\s+(?:13|14|15)(?:\.0+)?/);
  expect(cspMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});
