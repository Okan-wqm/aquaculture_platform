import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const GENERATED_SUBGRAPH_APP_MODULES: ReadonlyArray<string> = [
  'apps/auth-service/src/app.module.ts',
  'apps/farm-service/src/app.module.ts',
  'apps/sensor-service/src/app.module.ts',
  'apps/alert-engine/src/app.module.ts',
  'apps/hr-service/src/app.module.ts',
  'apps/billing-service/src/app.module.ts',
  'apps/hydroponics-service/src/app.module.ts',
  'apps/config-service/src/app.module.ts',
  'apps/notification-service/src/app.module.ts',
  'apps/messaging-service/src/app.module.ts',
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function readModule(path: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
}

function indexAfterConfigure(src: string, token: string): number {
  const configureStart = src.indexOf('configure(consumer');
  if (configureStart === -1) {
    return -1;
  }
  return src.indexOf(token, configureStart);
}

describe('INVARIANT: generated subgraphs require verified user assertion before user context', () => {
  it.each(GENERATED_SUBGRAPH_APP_MODULES)('%s wires the canonical auth context middleware order', (path) => {
    const src = readModule(path);

    expect(src).toMatch(
      /import\s+\{[^}]*\bVerifiedUserAssertionMiddleware\b[^}]*\}\s+from\s+['"]@aquaculture\/backend-common\/middleware['"]/,
    );

    const stripIdx = indexAfterConfigure(src, 'StripInternalHeadersMiddleware');
    const assertionIdx = indexAfterConfigure(src, 'VerifiedUserAssertionMiddleware');
    const userIdx = indexAfterConfigure(src, 'UserContextMiddleware');
    const tenantIdx = indexAfterConfigure(src, 'TenantContextMiddleware');

    expect(stripIdx).toBeGreaterThanOrEqual(0);
    expect(assertionIdx).toBeGreaterThan(stripIdx);
    expect(userIdx).toBeGreaterThan(assertionIdx);
    expect(tenantIdx).toBeGreaterThan(userIdx);
  });
});
