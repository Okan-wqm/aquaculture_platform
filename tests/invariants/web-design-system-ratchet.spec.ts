/**
 * INVARIANT — design-system adoption in the web tree only moves one way
 * (FE-HIGH-065 / FE-HIGH-066 / FE-MEDIUM-067).
 *
 * `web/shared-ui` is a real design system: 61 colour tokens, Modal /
 * ConfirmModal / Drawer with one shared dialog behaviour, Button, form fields.
 * The September 2026 survey found the product mostly not using it: 96 files
 * carried their own `fixed inset-0` overlay (55 with an unlabelled close
 * button, 111 of them stacked on the same `z-50`), 2,136 raw hex colours sat
 * outside `theme.css` (sensor-module alone wrote `#ff0000` 28 times for SCADA
 * alarms), and 683 inline `style={{…}}` blocks bypassed the token system.
 *
 * None of that can be fixed in one change, and none of it may grow while it is
 * being fixed. So this spec is a governed ratchet, the same shape as
 * `admin-panel-data-layer.spec.ts`:
 *
 *   1. **Overlays are keyed by FILE.** Every file outside shared-ui that
 *      contains `fixed inset-0` must be listed with a batch (dialog → Modal,
 *      drawer → Drawer, mobile → bottom sheet, runtime → a genuine full-screen
 *      surface that is not a dialog), an owner, a future expiry, the finding
 *      and a reason; every listed file must still contain one, so a migrated
 *      file cannot hold the ceiling up. The ceiling only decreases.
 *
 *   2. **Raw hex and inline style are keyed by PACKAGE.** Each web package has
 *      an occurrence ceiling; a package not listed must be at zero. Counting is
 *      by occurrence, not by file, so moving colours between files is not
 *      progress and adding one to a listed file is caught.
 *
 * Detection is deliberately textual and identical to the survey (`git
 * ls-files` + a regex on the raw source, tests and generated code excluded) so
 * the numbers in the allowlist mean exactly what the survey meant.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../..');
const ALLOWLIST = '.claude/allowlists/web-design-system-ratchet.yaml';
const ROOTS = ['web/modules', 'web/shell/src', 'web/apps'];

const OVERLAY = /fixed inset-0/;
const RAW_HEX = /#[0-9a-fA-F]{6}\b/g;
const INLINE_STYLE = /style=\{\{/g;

interface OverlayEntry {
  site: string;
  batch: 'dialog' | 'drawer' | 'mobile' | 'runtime';
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface PackageCeiling {
  package: string;
  ceiling: number;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface Allowlist {
  version: number;
  overlays: { ceiling: number; entries: OverlayEntry[] };
  rawHex: { entries: PackageCeiling[] };
  inlineStyle: { entries: PackageCeiling[] };
}

/** Tracked source files under ROOTS, tests and generated code excluded (see admin-panel-data-layer.spec.ts on why not a `**` pathspec). */
function sourceFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...ROOTS], { encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) =>
        (file.endsWith('.ts') || file.endsWith('.tsx')) &&
        !/__tests__/.test(file) &&
        !/\.(spec|test)\.tsx?$/.test(file) &&
        !file.includes('/generated/') &&
        !file.includes('/node_modules/'),
    );
}

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/** `web/modules/<name>`, `web/shell` or `web/apps/<name>` — the unit a ceiling is granted to. */
function packageOf(file: string): string {
  const pkg = /^(web\/modules\/[^/]+|web\/shell|web\/apps\/[^/]+)/.exec(file)?.[1];
  if (!pkg) throw new Error(`file outside a web package: ${file}`);
  return pkg;
}

function expiryIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function countByPackage(files: string[], pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const hits = read(file).match(pattern)?.length ?? 0;
    if (hits === 0) continue;
    const pkg = packageOf(file);
    counts.set(pkg, (counts.get(pkg) ?? 0) + hits);
  }
  return counts;
}

function assertGoverned(
  entry: { owner: string; expiry: string | Date; findingId: string; reason: string },
  today: string,
): void {
  expect(entry.owner).toBeTruthy();
  expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
  expect(entry.reason.length).toBeGreaterThan(20);
  expect(expiryIso(entry.expiry) > today).toBe(true);
}

describe('INVARIANT (FE-HIGH-065/077, FE-MEDIUM-067): web design-system adoption ratchet', () => {
  const files = sourceFiles();
  const doc = yaml.load(read(ALLOWLIST)) as Allowlist;
  const today = new Date().toISOString().slice(0, 10);

  it('sees the web tree', () => {
    // A path typo would otherwise make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(800);
    expect(files.some((f) => f.startsWith('web/modules/sensor-module/'))).toBe(true);
    expect(files.some((f) => f.startsWith('web/apps/aquamobil/'))).toBe(true);
  });

  it('ratchets every hand-rolled overlay — governed, live, and only shrinking (FE-HIGH-065)', () => {
    const actual = new Set(files.filter((file) => OVERLAY.test(read(file))));
    const listed = new Set(doc.overlays.entries.map((entry) => entry.site));

    // A new overlay cannot ship outside shared-ui without being named here.
    expect([...actual].filter((file) => !listed.has(file)).sort()).toEqual([]);
    // A migrated file cannot stay listed to hold the ceiling up.
    expect([...listed].filter((file) => !actual.has(file)).sort()).toEqual([]);

    for (const entry of doc.overlays.entries) {
      expect(entry.batch).toMatch(/^(dialog|drawer|mobile|runtime)$/);
      assertGoverned(entry, today);
    }

    expect(actual.size).toBeLessThanOrEqual(doc.overlays.ceiling);
    expect(doc.overlays.entries.length).toBeLessThanOrEqual(doc.overlays.ceiling);
  });

  it('ratchets raw hex colours outside theme.css per package (FE-HIGH-066)', () => {
    const actual = countByPackage(files, RAW_HEX);
    const ceilings = new Map(doc.rawHex.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      // A package with no ceiling must be at zero — the ceiling is the permission.
      expect(entry === undefined ? `${pkg}: ${count} raw hex, no ceiling` : '').toBe('');
      if (entry) expect({ pkg, count }).toEqual({ pkg, count: expect.any(Number) });
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} raw hex colours, ceiling ${entry.ceiling}. Use theme.css tokens (bg-primary-*, var(--color-*)) instead of raw values; lower the ceiling when you remove some.`,
        );
      }
    }
    for (const entry of doc.rawHex.entries) {
      assertGoverned(entry, today);
      // A ceiling above the live count is slack nobody earned: tighten it.
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });

  it('ratchets inline style={{}} blocks per package (FE-MEDIUM-067)', () => {
    const actual = countByPackage(files, INLINE_STYLE);
    const ceilings = new Map(doc.inlineStyle.entries.map((entry) => [entry.package, entry]));

    for (const [pkg, count] of actual) {
      const entry = ceilings.get(pkg);
      expect(entry === undefined ? `${pkg}: ${count} inline styles, no ceiling` : '').toBe('');
      if (entry && count > entry.ceiling) {
        throw new Error(
          `${pkg}: ${count} inline style blocks, ceiling ${entry.ceiling}. Prefer utility classes / tokens; lower the ceiling when you remove some.`,
        );
      }
    }
    for (const entry of doc.inlineStyle.entries) {
      assertGoverned(entry, today);
      expect(
        (actual.get(entry.package) ?? 0) === entry.ceiling
          ? ''
          : `${entry.package}: ceiling ${entry.ceiling}, live ${actual.get(entry.package) ?? 0}`,
      ).toBe('');
    }
  });
});
