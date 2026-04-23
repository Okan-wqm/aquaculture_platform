/**
 * Lib-creation rubric invariant
 * ============================================================================
 *
 * Enforces ADR-028 (Lib-creation rubric). Every directory the repo treats
 * as a "shared library" — under `libs/`, `platform/libs/`, `web/shared-ui`,
 * or any future `web/<lib-name>/` root — must have a matching row in the
 * ADR's Lib-inventory table. Likewise every row in the table must point
 * at a real directory with a package.json whose `name` field is set.
 *
 * This is the Tier-3 (make-detectable) companion to the Tier-4 (document)
 * ADR. Adding a new lib without updating the ADR fails CI — the PR author
 * is forced to place their lib into the rubric's taxonomy.
 *
 * # When this spec fails
 *
 *   - Filesystem has a dir the ADR does not mention → add a row.
 *   - ADR mentions a dir that doesn't exist → remove the row or create
 *     the dir.
 *   - A lib's package.json lacks `name` → add it; the ADR table column
 *     entries depend on npm package identity.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADR_PATH = path.resolve(REPO_ROOT, 'docs', 'adr', '028-lib-creation-rubric.md');

/**
 * Lib-roots the invariant walks. Every direct child directory of each
 * root is expected to appear in the ADR's Lib-inventory table (unless
 * explicitly exempted below).
 */
const LIB_ROOTS: readonly string[] = [
  'libs',
  'platform/libs',
];

/**
 * Standalone lib paths (not under a LIB_ROOT). Each is validated as
 * a single lib rather than walked for children.
 */
const STANDALONE_LIBS: readonly string[] = [
  'web/shared-ui',
];

/**
 * Dirs that exist under LIB_ROOTS but are NOT libs — internal
 * scratch/legacy dirs that must not appear in the inventory.
 */
const LIB_ROOT_EXEMPTIONS: ReadonlySet<string> = new Set([
  // None currently. Add here with a comment explaining why the dir
  // exists but is not a lib. An ADR amendment is preferable.
]);

interface InventoryRow {
  path: string;
  rubric: string;
}

/**
 * Parse the Markdown table under the "## Lib inventory" heading of
 * ADR-028. Each row's first column is the lib path (possibly wrapped
 * in backticks), the second column is the rubric category.
 *
 * The parser is deliberately small and strict — it expects exactly the
 * ADR's layout. A looser parser would mask drift in the ADR itself.
 */
function parseInventoryTable(): InventoryRow[] {
  const text = readFileSync(ADR_PATH, 'utf8');
  const sectionMatch = /^## Lib inventory[\s\S]*?(?=^## |\z)/m.exec(text);
  if (!sectionMatch) {
    throw new Error(`ADR-028 is missing "## Lib inventory" section at ${ADR_PATH}`);
  }
  const section = sectionMatch[0];
  const rows: InventoryRow[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    // Skip header (| Path | Rubric row | Consumers |) and separator
    // (|---|---|---|) — both recognizable by their first cell content.
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const first = cells[0]!;
    if (/^-+$/.test(first)) continue;
    if (first === 'Path') continue;
    const pathMatch = /^`([^`]+)`/.exec(first);
    if (!pathMatch) continue;
    let p = pathMatch[1]!;
    // Strip any trailing "/" so string comparison with readdirSync() output matches.
    if (p.endsWith('/')) p = p.slice(0, -1);
    rows.push({ path: p, rubric: cells[1]! });
  }
  return rows;
}

function listDirectChildDirs(root: string): string[] {
  const abs = path.resolve(REPO_ROOT, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${root}/${e.name}`)
    .filter((p) => !LIB_ROOT_EXEMPTIONS.has(p))
    .sort();
}

function packageJsonName(libPath: string): string | null {
  const pkgPath = path.resolve(REPO_ROOT, libPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

describe('ADR-028 Lib-creation rubric invariant', () => {
  const inventory = parseInventoryTable();
  const inventoryPaths = new Set(inventory.map((r) => r.path));

  describe('every directory under LIB_ROOTS is listed in ADR-028', () => {
    for (const root of LIB_ROOTS) {
      const children = listDirectChildDirs(root);
      for (const libPath of children) {
        it(`${libPath} must appear in ADR-028 Lib inventory`, () => {
          expect(inventoryPaths.has(libPath)).toBe(true);
        });
      }
    }
  });

  describe('every standalone lib path exists and is listed', () => {
    for (const libPath of STANDALONE_LIBS) {
      it(`${libPath} must exist on disk AND appear in ADR-028`, () => {
        const abs = path.resolve(REPO_ROOT, libPath);
        expect(existsSync(abs) && statSync(abs).isDirectory()).toBe(true);
        expect(inventoryPaths.has(libPath)).toBe(true);
      });
    }
  });

  describe('every ADR-028 row points at a real directory', () => {
    for (const row of inventory) {
      it(`"${row.path}" listed in ADR-028 must exist on disk`, () => {
        const abs = path.resolve(REPO_ROOT, row.path);
        expect(existsSync(abs) && statSync(abs).isDirectory()).toBe(true);
      });
    }
  });

  describe('every listed lib has a valid package.json.name IF a package.json is present', () => {
    // A subset of libs are tsconfig-path-only (no package.json — they
    // exist purely as TypeScript path aliases in tsconfig.base.json).
    // The invariant only requires a populated `name` for libs that
    // have chosen to expose a package.json. Adding a package.json to
    // a tsconfig-path-only lib is encouraged but not mandatory —
    // doing so does not require an ADR amendment.
    for (const row of inventory) {
      it(`${row.path}: package.json.name populated OR lib is tsconfig-path-only`, () => {
        const abs = path.resolve(REPO_ROOT, row.path);
        if (!existsSync(abs)) {
          return; // exists-test catches this separately
        }
        const pkgPath = path.resolve(abs, 'package.json');
        if (!existsSync(pkgPath)) {
          // tsconfig-path-only lib: no package.json present, acceptable.
          return;
        }
        const name = packageJsonName(row.path);
        expect(name).not.toBeNull();
        expect(name).not.toMatch(/^\s*$/);
      });
    }
  });
});
