/**
 * Platform-wide invariant — ORPHAN-HIGH (tenant-context SSoT, Workstream B):
 *
 * A SUPER_ADMIN acts-as a tenant; the gateway is the SINGLE authority that
 * resolves ONE `effectiveTenantId`, signs it into the HMAC user-assertion, and
 * every tenant-scoped read consumes that signed value. This invariant locks the
 * load-bearing WIRING so a future refactor cannot silently re-introduce the
 * "data sometimes loads, sometimes not" bug (the act-as never reaching the
 * subgraph → non-deterministic search_path / RLS GUC).
 *
 * It enforces, by source inspection (fires on every PR, no boot needed):
 *   1. Gateway middleware ORDER:
 *        CaptureRequestedTenantMiddleware  BEFORE StripInternalHeadersMiddleware
 *          (so the spoofable act-as header is captured before it is stripped),
 *        EffectiveTenantMiddleware         AFTER  JwtMiddleware
 *          (so req.user exists when the effective tenant is resolved+validated).
 *   2. The gateway SIGNS `effectiveTenantId` from the resolved `req.effectiveTenantId`
 *      (NOT only the JWT `user.tenantId`) on BOTH outbound paths — the federation
 *      data source and the REST proxy.
 *   3. The RLS-GUC feeder (`request-context.middleware.ts`) reads the verified
 *      `req.tenantId` (signed-assertion value) BEFORE any spoofable header.
 *
 * Why source-level: a reorder or a revert to `effectiveTenantId: user.tenantId`
 * is exactly the regression class that would re-break SUPER_ADMIN act-as while
 * leaving every unit test green (regular users are unaffected). Grep on the
 * canonical files catches it in one fast pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readStripped(relPath: string): string {
  const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  // Drop block + line comments so docstrings mentioning the symbols do not
  // register as positional/textual occurrences.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

describe('INVARIANT (tenant-context SSoT): gateway resolves + signs ONE effectiveTenantId', () => {
  const gateway = () => readStripped('apps/gateway-api/src/app.module.ts');

  it('CaptureRequestedTenantMiddleware is mounted BEFORE StripInternalHeadersMiddleware', () => {
    const src = gateway();
    const cfg = src.indexOf('configure(consumer');
    const capture = src.indexOf('CaptureRequestedTenantMiddleware', cfg);
    const strip = src.indexOf('StripInternalHeadersMiddleware', cfg);
    expect(capture).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(strip);
  });

  it('EffectiveTenantMiddleware is mounted AFTER JwtMiddleware (req.user populated)', () => {
    const src = gateway();
    const cfg = src.indexOf('configure(consumer');
    const jwt = src.indexOf('JwtMiddleware', cfg);
    const effective = src.indexOf('EffectiveTenantMiddleware', cfg);
    expect(jwt).toBeGreaterThan(-1);
    expect(effective).toBeGreaterThan(-1);
    expect(effective).toBeGreaterThan(jwt);
  });

  it('federation data source SIGNS effectiveTenantId from req.effectiveTenantId (not only user.tenantId)', () => {
    const src = readStripped('apps/gateway-api/src/federation/authenticated-data-source.ts');
    // The assertion build must derive effectiveTenantId from the resolved value.
    expect(/effectiveTenantId:\s*req\.effectiveTenantId\s*\?\?/.test(src)).toBe(true);
    // And the forwarded x-tenant-id must use it too.
    expect(/req\.effectiveTenantId\s*\?\?\s*req\.user\?\.tenantId/.test(src)).toBe(true);
  });

  it('REST proxy SIGNS effectiveTenantId from req.effectiveTenantId (assertion + wire agree)', () => {
    const src = readStripped('apps/gateway-api/src/proxy/service-proxy.service.ts');
    expect(/effectiveTenantId\s*\?\?\s*user\.tenantId/.test(src)).toBe(true);
    // wire tenantId must prefer the effective tenant so it matches the assertion.
    expect(/effectiveTenantId\s*\?\?\s*\n?\s*resolveTenantIdFromRequest/.test(src)).toBe(true);
  });

  it('RLS-GUC feeder reads the verified req.tenantId BEFORE any spoofable header', () => {
    const src = readStripped('libs/backend-common/src/logging/request-context.middleware.ts');
    const verified = src.indexOf('verifiedTenantId');
    const header = src.indexOf("req.headers['x-tenant-id']");
    expect(verified).toBeGreaterThan(-1);
    expect(header).toBeGreaterThan(-1);
    // The verified (req.tenantId) read must appear before the header fallback.
    expect(verified).toBeLessThan(header);
  });
});
