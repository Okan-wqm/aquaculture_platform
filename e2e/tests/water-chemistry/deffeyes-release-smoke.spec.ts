import { expect, test } from '@playwright/test';

type ExpectedMode = 'ph' | 'legacy';

function expectedMode(): ExpectedMode {
  const mode = process.env.FARM_WATER_CHEMISTRY_EXPECT_MODE ?? 'ph';
  if (mode !== 'ph' && mode !== 'legacy') {
    throw new Error(`Invalid FARM_WATER_CHEMISTRY_EXPECT_MODE=${mode}`);
  }
  return mode;
}

test('Deffeyes chart mode, report print, and CSP stay release-safe', async ({ page }) => {
  const cspMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/content security policy|violat/i.test(text)) {
      cspMessages.push(text);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(process.env.FARM_WATER_CHEMISTRY_PATH ?? '');

  if (expectedMode() === 'ph') {
    await expect(page.getByTestId('deffeyes-ph-chart')).toBeVisible();
  } else {
    await expect(page.getByTestId('deffeyes-ph-chart')).toHaveCount(0);
    await expect(page.getByText('Water Quality Management Chart').first()).toBeVisible();
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
