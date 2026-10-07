import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * INVARIANT: the device spellings of a measured quantity have ONE owner — the
 * channel-key table in `libs/shared-contracts/src/measurement/quantities.ts`.
 *
 * The alias table used to live twice (the reading event's channel-key map and
 * the sensor catalog), and the two disagreed on which keys exist: `waterlevel`
 * was readable but not registrable. Both now derive from the registry. This
 * fails when a file declares an object keyed by two or more of the alias
 * spellings below — the shape every copy had — anywhere but the registry.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY = 'libs/shared-contracts/src/measurement/quantities.ts';
const SCAN_ROOTS = ['apps', 'libs', 'platform/libs', 'web'];

/** Spellings that only an alias table would use as object keys. */
const ALIAS_KEYS = [
  'water_temp',
  'water_temperature',
  'ph_level',
  'do_level',
  'dissolvedoxygen',
  'waterlevel',
  'total_ammonia',
  'hydrogen_sulfide',
  'carbon_dioxide',
  'battery_level',
];
const ALIAS_KEY_DECL = new RegExp(`^\\s*'?(${ALIAS_KEYS.join('|')})'?\\s*:`, 'gm');

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'migrations') continue;
      out.push(...sourceFilesUnder(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INVARIANT: one owner for measured-quantity spellings', () => {
  it('the registry declares the alias table', () => {
    const src = readFileSync(resolve(REPO_ROOT, REGISTRY), 'utf8');
    expect(new Set([...stripComments(src).matchAll(ALIAS_KEY_DECL)].map((m) => m[1])).size).toBe(
      ALIAS_KEYS.length,
    );
  });

  it('no other file declares an object keyed by alias spellings', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFilesUnder(resolve(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === REGISTRY) continue;
        const raw = readFileSync(file, 'utf8');
        if (!ALIAS_KEYS.some((key) => raw.includes(key))) continue;
        const keys = new Set([...stripComments(raw).matchAll(ALIAS_KEY_DECL)].map((m) => m[1]));
        if (keys.size >= 2) {
          offenders.push(`${rel}: ${[...keys].join(', ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
