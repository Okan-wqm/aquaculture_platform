/**
 * APA-371 (tier-1/3) — the guard-bypass key ('isPublic') is a single shared symbol.
 *
 * The `isPublic` bypass key was declared independently in FOUR places
 * (backend-common roles.decorator, admin-api public.decorator, the guard's own
 * export, and a private re-implementation inside password-reset.controller). The
 * guard bypass worked only because all four string literals happened to equal
 * 'isPublic'; a rename in any one place would silently expose an endpoint or
 * silently break the public password-reset flow with no compile-time error.
 *
 * The fix converges every admin-api reader/stamper onto the ONE backend-common
 * symbol (admin-api's public.decorator re-exports it). This gate keeps it
 * converged: it fails the build if any admin-api file re-declares the bypass key
 * or hand-rolls a local Public() decorator instead of importing the canonical one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const readRel = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const CANONICAL = 'libs/backend-common/src/decorators/roles.decorator.ts';
const ADMIN_PUBLIC_DECORATOR = 'apps/admin-api-service/src/decorators/public.decorator.ts';
const ADMIN_SRC = resolve(REPO_ROOT, 'apps/admin-api-service/src');

/** Recursively collect production `*.ts` files (excluding specs/tests + migrations). */
function collectTsFiles(dirAbs: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const name of names) {
    const abs = join(dirAbs, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      // migrations legitimately reference an `"isPublic"` DB column (system_settings);
      // exclude them so the column name is never mistaken for the metadata key.
      if (name === 'node_modules' || name === '__tests__' || name === 'migrations') continue;
      out.push(...collectTsFiles(abs));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

// Re-declaration shapes the convergence forbids anywhere but the canonical files.
const LOCAL_KEY_DECL = /\b(?:export\s+)?const\s+IS_PUBLIC_KEY\s*=/;
const LOCAL_PUBLIC_DECL = /\bconst\s+Public\s*=/;
const STAMPS_BYPASS = /SetMetadata\(\s*(?:IS_PUBLIC_KEY|['"]isPublic['"])/;

describe('APA-371 — single shared isPublic bypass symbol', () => {
  it('backend-common defines the canonical IS_PUBLIC_KEY (SSoT anchor)', () => {
    const src = readRel(CANONICAL);
    expect(/export const IS_PUBLIC_KEY = ['"]isPublic['"]/.test(src)).toBe(true);
  });

  it("admin-api's public.decorator re-exports the canonical symbol and re-declares nothing", () => {
    const src = readRel(ADMIN_PUBLIC_DECORATOR);
    expect(src.includes("from '@aquaculture/backend-common/decorators'")).toBe(true);
    expect(src.includes('export {')).toBe(true);
    // It must be a pure re-export: no local literal, no hand-rolled decorator.
    expect(STAMPS_BYPASS.test(src)).toBe(false);
    expect(/=\s*['"]isPublic['"]/.test(src)).toBe(false);
  });

  it('no other admin-api source re-declares the bypass key or a local Public() decorator', () => {
    const offenders = collectTsFiles(ADMIN_SRC)
      .filter((abs) => abs !== resolve(REPO_ROOT, ADMIN_PUBLIC_DECORATOR))
      .map((abs) => ({ rel: abs.slice(REPO_ROOT.length + 1), src: readFileSync(abs, 'utf-8') }))
      .filter(
        ({ src }) =>
          LOCAL_KEY_DECL.test(src) || LOCAL_PUBLIC_DECL.test(src) || STAMPS_BYPASS.test(src),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
