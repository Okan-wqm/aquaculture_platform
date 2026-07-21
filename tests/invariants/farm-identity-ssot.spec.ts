import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT: farm identity SSOT uses verified assertions', () => {
  const dataSource = read('apps/gateway-api/src/federation/authenticated-data-source.ts');
  const farmApp = read('apps/farm-service/src/app.module.ts');
  const assertionMiddleware = read('libs/backend-common/src/middleware/verified-user-assertion.middleware.ts');
  const serviceIdentity = read('libs/backend-common/src/utils/service-identity.util.ts');

  it('gateway federation mints verified assertions and does not forward legacy raw user headers', () => {
    expect(dataSource).toMatch(/x-verified-user-assertion/);
    expect(dataSource).toMatch(/buildGatewayVerifiedUserAssertion/);
    expect(dataSource).not.toMatch(/headers\.set\('x-user-id'/);
    expect(dataSource).not.toMatch(/headers\.set\('x-user-roles'/);
    expect(dataSource).not.toMatch(/headers\.set\('x-user-payload'/);
  });

  // NOTE (APA-252): the gateway REST proxy (ServiceProxyService) was deleted as
  // dead code — it was provided by no module and had zero consumers, so its
  // header-quarantine logic never ran. The LIVE identity path is the GraphQL
  // federation data source (asserted above) plus VerifiedUserAssertionMiddleware
  // and the service-identity HMAC (asserted below); no live boundary is lost.

  it('farm parses verified assertions before legacy user context and GraphQL context does not trust raw headers', () => {
    expect(farmApp).toMatch(/VerifiedUserAssertionMiddleware/);
    const middlewareChain = farmApp.slice(farmApp.indexOf('.apply('));
    expect(middlewareChain.indexOf('VerifiedUserAssertionMiddleware')).toBeLessThan(
      middlewareChain.indexOf('UserContextMiddleware'),
    );
    expect(farmApp).not.toMatch(/req\.headers\['x-user-payload'\]/);
    expect(farmApp).not.toMatch(/req\.headers\['x-user-id'\]/);
    expect(farmApp).not.toMatch(/req\.headers\['x-user-roles'\]/);
  });

  it('verified assertions require gateway service identity and signed effective tenant agreement', () => {
    expect(assertionMiddleware).toMatch(/req\.verifiedIdentity\.serviceName !== 'gateway-api'/);
    expect(assertionMiddleware).toMatch(/assertion\.effectiveTenantId !== req\.verifiedIdentity\.tenantId/);
    expect(assertionMiddleware).toMatch(/Reflect\.deleteProperty\(req\.headers, header\)/);
  });

  it('service HMAC binds query, content-type, body, tenant, and assertion hash', () => {
    expect(serviceIdentity).toMatch(/X-Service-Query-Hash/);
    expect(serviceIdentity).toMatch(/X-Service-Content-Type/);
    expect(serviceIdentity).toMatch(/X-Service-Assertion-Hash/);
    expect(serviceIdentity).toMatch(/observedQuery/);
    expect(serviceIdentity).toMatch(/observedContentType/);
    expect(serviceIdentity).toMatch(/observedAssertion/);
  });
});
