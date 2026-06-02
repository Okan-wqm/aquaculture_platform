import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT: token blacklist has one canonical platform SSoT', () => {
  it('does not keep the retired gateway-local blacklist store', () => {
    const retiredStorePath = [
      'apps/gateway-api/src/guards',
      ['redis-token-blacklist', 'store.ts'].join('.'),
    ].join('/');
    expect(existsSync(resolve(REPO_ROOT, retiredStorePath))).toBe(false);
  });

  it('keeps the canonical TOKEN_BLACKLIST declaration in backend-common', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/security/interfaces/index.ts'),
      'utf8',
    );
    expect(src).toMatch(/export\s+const\s+TOKEN_BLACKLIST\s*=\s*['"`]TOKEN_BLACKLIST['"`]/);
    expect(src).not.toMatch(/TOKEN_BLACKLIST_STORE/);
  });
});
