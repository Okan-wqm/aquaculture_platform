import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * ORPHAN-HIGH-812 — detectable tier: the authentication flows write
 * `auth.users` only through the two column-scoped stores.
 *
 * WHY: `save(user)` on an entity loaded earlier diffs every mapped column
 * against the row and writes the differences back, so bookkeeping on a stale
 * snapshot reverts a password, role or active-flag change that committed in
 * between (proved on real Postgres in credential-issuance.postgres.spec.ts).
 * A new flow that reaches for `userRepository.save(...)` again must fail here,
 * not in production.
 */
const SERVICES_DIR = join(__dirname, '..', 'services');
const STORES = new Set(['user-account.store.ts', 'user-mfa-state.store.ts']);

/** Whole-entity writes of a User, in every spelling these services have used. */
const WHOLE_USER_WRITE = [
  /\buserRepository\s*\.\s*save\s*\(/,
  /\.\s*save\s*\(\s*User\s*,/,
  /\(\s*manager\s*,\s*User\s*\)\s*\.\s*save\s*\(/,
];

function serviceSources(): Array<{ file: string; source: string }> {
  return readdirSync(SERVICES_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => ({ file, source: readFileSync(join(SERVICES_DIR, file), 'utf8') }));
}

describe('auth.users write discipline in the authentication services (ORPHAN-HIGH-812)', () => {
  it('finds the service sources it guards (a moved directory must not pass vacuously)', () => {
    const files = serviceSources().map(({ file }) => file);
    expect(files).toEqual(
      expect.arrayContaining([
        'authentication.service.ts',
        'mfa.service.ts',
        'webauthn.service.ts',
        'account.service.ts',
        ...STORES,
      ]),
    );
  });

  it('no flow saves a whole User entity', () => {
    const offenders = serviceSources()
      .filter(({ file }) => !STORES.has(file))
      .flatMap(({ file, source }) =>
        source
          .split('\n')
          .flatMap((line, index) =>
            WHOLE_USER_WRITE.some((pattern) => pattern.test(line))
              ? [`${file}:${index + 1}: ${line.trim()}`]
              : [],
          ),
      );
    expect(offenders).toEqual([]);
  });

  it('the stores themselves never save an entity — every write names its columns', () => {
    const offenders = serviceSources()
      .filter(({ file }) => STORES.has(file))
      .flatMap(({ file, source }) => (/\.\s*save\s*\(/.test(source) ? [file] : []));
    expect(offenders).toEqual([]);
  });

  it('the pattern set still recognises each historical spelling', () => {
    for (const spelling of [
      'await this.userRepository.save(user);',
      'await userRepository.save(user);',
      'await manager.save(User, user);',
      'await this.preTenantAuthRepository(manager, User).save(user);',
    ]) {
      expect(WHOLE_USER_WRITE.some((pattern) => pattern.test(spelling))).toBe(true);
    }
  });
});
