import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUTH_SRC = resolve(REPO_ROOT, 'apps/auth-service/src');
const TOKEN_ISSUER = resolve(AUTH_SRC, 'modules/authentication/services/token.service.ts');

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'test' || entry === 'migrations') {
        continue;
      }
      files.push(...walkTsFiles(absolute));
      continue;
    }

    if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.e2e-spec.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      files.push(absolute);
    }
  }

  return files;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('INVARIANT: auth-service token issuance is owned by TokenIssuerService', () => {
  it('keeps TokenIssuerService as the only production JWT signing boundary', () => {
    const violations = walkTsFiles(AUTH_SRC)
      .filter((file) => file !== TOKEN_ISSUER)
      .flatMap((file) => {
        const src = read(file);
        return /\bjwtService\s*\.\s*sign(?:Async)?\s*\(/.test(src)
          ? [relative(REPO_ROOT, file)]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it('does not expose the deprecated TokenService issuer alias in production code', () => {
    const tokenIssuerSource = read(TOKEN_ISSUER);
    expect(tokenIssuerSource).not.toMatch(/\bTokenService\b/);

    const violations = walkTsFiles(AUTH_SRC)
      .filter((file) => file !== TOKEN_ISSUER)
      .flatMap((file) => {
        const src = read(file);
        return /\bTokenService\b/.test(src) ? [relative(REPO_ROOT, file)] : [];
      });

    expect(violations).toEqual([]);
  });
});
