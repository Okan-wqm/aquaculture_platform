/**
 * English-only gate for the two admin panels (ADMIN-MEDIUM-009).
 *
 * Decision of record: the admin-panel (SUPER_ADMIN) and tenant-admin
 * (TENANT_ADMIN) frontends are English-only. ADMIN-MEDIUM-009 normalised the
 * last Turkish strings + comments in both `src/` trees; this invariant makes a
 * regression impossible to MERGE rather than merely fixed once — any source
 * file under either module's `src/` that reintroduces a Turkish-specific
 * character fails CI with the offending file list (make-it-impossible, Tier-1).
 *
 * Why a JS regex over a shelled-out `grep`: JavaScript strings are UTF-16, so
 * `/[çğıöşüÇĞİÖŞÜ]/` matches ONLY those exact code points. A byte-wise `grep`
 * in a non-UTF-8 locale (the CI default when `LANG` is unset) reports emoji
 * icons (🐟, 💾, 👥) as false positives, because their UTF-8 byte sequences
 * overlap the Turkish letters' bytes. This gate is therefore both correct
 * (no emoji noise) and self-contained (no locale dependency).
 *
 * Scope note: this enforces the Turkish-SPECIFIC letters only. ASCII-only
 * transliterated Turkish (e.g. "Otomasyon") shares the Latin alphabet with
 * English and cannot be gated without unacceptable false positives on real
 * English words; it is caught by human review, not by this structural gate.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The two admin frontends whose `src/` trees are English-only. */
const SCANNED_ROOTS = [
  'web/modules/admin-panel/src',
  'web/modules/tenant-admin/src',
] as const;

/** Never descend into build output or installed deps. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'build', '.nx']);

/**
 * Turkish-specific letters (both cases). Latin letters shared with English
 * (a, e, o, u, ...) are deliberately excluded — only the diacritic/dotless
 * forms unique to Turkish are banned.
 */
const TURKISH_CHARS = /[çğıöşüÇĞİÖŞÜ]/u;

function walk(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(childAbs));
    } else if (entry.isFile()) {
      out.push(childAbs);
    }
  }
  return out;
}

describe('INVARIANT: admin panels are English-only (ADMIN-MEDIUM-009)', () => {
  it('no source file under either admin module contains Turkish-specific characters', () => {
    const offenders: string[] = [];

    for (const root of SCANNED_ROOTS) {
      const rootAbs = resolve(REPO_ROOT, root);
      for (const fileAbs of walk(rootAbs)) {
        if (TURKISH_CHARS.test(readFileSync(fileAbs, 'utf-8'))) {
          offenders.push(relative(REPO_ROOT, fileAbs));
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Found ${offenders.length} file(s) containing Turkish-specific characters ` +
          `[çğıöşüÇĞİÖŞÜ]. The admin panels are English-only (ADMIN-MEDIUM-009). ` +
          `Translate the offending strings/comments to English:\n` +
          offenders.map((f) => `  ${f}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });
});
