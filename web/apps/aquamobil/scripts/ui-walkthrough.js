/**
 * UI walkthrough probe (2026-09-17) — drives the DEPLOYED app with a real
 * account: logs in once, records a mortality through the actual form, then
 * client-side navigates every route capturing body text + GraphQL errors.
 * Companion to validate-e2e.mjs (which covers the API contract). See
 * ../CONNECTION-STATUS.md for the findings this produced.
 *
 * Usage: node scripts/ui-walkthrough.js  (edit EMAIL/PASSWORD below; budget
 * for the 5-logins/15-min server limit).
 */
const { chromium } = require('playwright');
const BASE = 'https://89.38.97.90:8443/mobile';
(async () => {
  const b = await chromium.launch({ channel: 'chromium-headless-shell' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  const gqlFails = [];
  p.on('response', async r => {
    if (r.url().includes('/graphql')) { try { const j = await r.json(); if (j.errors) gqlFails.push(j.errors.map(e => e.message.slice(0, 70)).join('|')); } catch {} }
  });
  // ---- LOGIN (tek deneme)
  await p.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.fill('#login-email', 'codex-test-202605240515@suderra.test');
  await p.fill('#login-password', '123456');
  await p.getByRole('button', { name: /sign in/i }).click();
  for (let i = 0; i < 20 && p.url().includes('/login'); i++) await p.waitForTimeout(1000);
  console.log('LOGIN:', p.url().includes('/login') ? 'BASARISIZ' : 'OK -> ' + p.url());
  if (p.url().includes('/login')) { await b.close(); process.exit(1); }
  await p.waitForTimeout(4000);

  const go = async (route) => {
    await p.evaluate(r => { window.history.pushState({}, '', '/mobile' + r); window.dispatchEvent(new PopStateEvent('popstate')); }, route);
    await p.waitForTimeout(1900);
    return p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 170));
  };

  // ---- 1) MORTALITY YAZMA (UI)
  const m1 = await go('/mortality/record');
  console.log('MORT SAYFA:', m1.slice(0, 110));
  const sel = p.locator('select').first();
  const opts = await sel.locator('option').allTextContents();
  console.log('tank secenekleri:', opts.slice(0, 5));
  const target = opts.find(o => /E2E-Cage-1\s*-\s*B-2026-00001/.test(o));
  await sel.selectOption({ index: opts.indexOf(target) });
  await p.waitForTimeout(1200);
  // v4 quantity is a stepper (aria-label "Increase ..."), not a number input
  const inc = p.getByRole('button', { name: /increase/i }).first();
  await inc.click(); await inc.click();
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: /disease/i }).first().click().catch(async () => {
    await p.getByText(/disease/i).first().click().catch(() => console.log('reason: elle secilemedi, varsayilan UNKNOWN'));
  });
  await p.waitForTimeout(500);
  const review = p.getByRole('button', { name: /review/i }).first();
  if (await review.count()) { await review.click(); await p.waitForTimeout(900); }
  const submit = p.getByRole('button', { name: /confirm & record/i }).first();
  console.log('submit:', await submit.count());
  await submit.click();
  await p.waitForTimeout(9000);
  const post = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200));
  console.log('KAYIT SONRASI:', post);

  // ---- 2) stock events ekranindan geri okuma
  const stock = await go('/operations/stock');
  console.log('STOCK EVENTS:', stock.slice(0, 140));

  // ---- 3) tum ekranlar
  for (const r of ['/feeding/record', '/water-quality/record', '/lice/record', '/welfare/record', '/escape/record',
    '/tasks', '/reports', '/alerts', '/notifications', '/messages', '/storage', '/storage/view', '/sync',
    '/account', '/more', '/drives', '/schedule', '/attendance', '/leave', '/cull/record', '/harvest/record', '/transfer/record']) {
    const body = await go(r);
    const auth = body.includes('Welcome back');
    console.log((auth ? 'AUTH' : 'OK  '), r.padEnd(22), '|', body.slice(0, 82));
  }
  console.log('GraphQL hatalari:', JSON.stringify([...new Set(gqlFails)].slice(0, 8)));
  await p.screenshot({ path: '/tmp/final-last.png' });
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
