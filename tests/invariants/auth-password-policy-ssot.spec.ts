import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ALLOWED = new Set([
  'libs/backend-common/src/security/password-policy.ts',
  'apps/auth-service/src/modules/authentication/dto/password-policy.ts',
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage', '.git', '.nx'].includes(entry)) continue;
    const absolute = join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...walk(absolute));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

describe('INVARIANT: password policy validation has one SSoT', () => {
  it('rejects hard-coded password policy regexes/messages outside the shared policy', () => {
    const offenders = walk(resolve(REPO_ROOT, 'apps'))
      .concat(walk(resolve(REPO_ROOT, 'libs')))
      .flatMap((file) => {
        const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
        if (ALLOWED.has(rel)) return [];
        const src = readFileSync(file, 'utf8');
        const hasPolicyRegex =
          src.includes('(?=.*[a-z])') &&
          src.includes('(?=.*[A-Z])') &&
          src.includes('(?=.*\\d)') &&
          src.includes('(?=.*[@$!%*?&])');
        const hasLegacyMessage =
          src.includes('Password must contain uppercase, lowercase, number and special character');
        return hasPolicyRegex || hasLegacyMessage ? [rel] : [];
      });

    expect(offenders).toEqual([]);
  });
});
