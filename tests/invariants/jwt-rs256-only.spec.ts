import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * RS256-ONLY JWT invariant (operator directive 2026-06-13; ADR-016 / CRITICAL-001).
 *
 * The platform is RS256-only: auth-service is the sole issuer and signs with
 * the RSA private key; every consumer verifies RS256-only via
 * getJwtVerifyOptions / PlatformJwtModule (`algorithms: ['RS256']`). HS256 is
 * an algorithm-confusion surface (a verifier accepting HS256 with the RS256
 * public key as the HMAC secret can be tricked into accepting forged tokens)
 * and is banned in ACTUAL CODE everywhere — no `algorithm: 'HS256'` signing
 * config and no `algorithms: ['HS256']` verify allowlist.
 *
 * Comments are stripped before matching, so historical "BEFORE: HS256" notes
 * that document the fixed vulnerability do not trip the gate — only live code.
 */

// Strip block + line comments + string-free of comment markers so prose like
// "previously used HS256" never counts. (Good-enough lexer for this gate: it
// removes /* ... */ and // ... regions; it is not a full JS parser but is
// sufficient to separate executable config from documentation.)
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const HS256_SIGN = /\balgorithm\s*:\s*['"]HS256['"]/;
const HS256_VERIFY = /\balgorithms\s*:\s*\[\s*['"]HS256['"]/;
// A `JWT_ALGORITHM` config/env key is the algorithm-confusion evasion vector:
// it sources the verify allowlist from a variable (default 'HS256'), slipping
// past the literal HS256 checks above. All verification must funnel through
// getJwtVerifyOptions (RS256 pinned); no code may read this key.
const JWT_ALGORITHM_KEY = /['"]JWT_ALGORITHM['"]/;

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps/**/*.ts', 'libs/**/*.ts', 'platform/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => existsSync(join(REPO_ROOT, f)))
    .filter(
      (f) => !/\.(spec|test)\.ts$/.test(f) && !f.includes('__tests__/') && !f.includes('/test/'),
    );
}

describe('JWT RS256-only invariant', () => {
  it('no live code signs or verifies with HS256 (algorithm-confusion ban)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (HS256_SIGN.test(code) || HS256_VERIFY.test(code)) {
        offenders.push(relative(REPO_ROOT, join(REPO_ROOT, file)));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no live code sources the JWT verify algorithm from a JWT_ALGORITHM key (allowlist-evasion ban)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (JWT_ALGORITHM_KEY.test(code)) {
        offenders.push(relative(REPO_ROOT, join(REPO_ROOT, file)));
      }
    }
    expect(offenders).toEqual([]);
  });
});
