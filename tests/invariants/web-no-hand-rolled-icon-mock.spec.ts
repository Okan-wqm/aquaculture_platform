/**
 * Web tests render lucide-react icons as they are; a hand-written mock of the
 * icon package is banned.
 *
 * WHY: ten specs replaced `lucide-react` with a list of stub components typed
 * out by hand. The list is a copy of "which icons do the components under test
 * import", and a copy drifts: when the hand-pasted `<svg>` blocks moved onto
 * lucide (FE-MEDIUM-082), four sensor-module suites failed at import with
 * `No "House" export is defined on the "lucide-react" mock`, and the fifth,
 * which had answered the drift with a catch-all `Proxy`, hung the whole test
 * job: the Proxy returned a component for *every* property — `then` included —
 * so vitest's `await factory()` waited on a thenable that never settles, and
 * the `test` job timed out at 35 minutes. The mock had been dead code until
 * the component actually imported the icon package.
 *
 * lucide icons are plain SVG function components; they render under jsdom and
 * carry `aria-hidden`, so nothing about them needs stubbing. Rendering the real
 * icon makes the drift impossible: there is no list to keep in step.
 *
 * SCOPE: every test file under `web/`. Mocking a *local* icon module of our
 * own is not matched; this is about the third-party icon set.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'web');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', 'generated']);
const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx|mts|cts)$/;

// `vi.mock('lucide-react', …)`, `vi.doMock("lucide-react")`, `jest.mock(\`lucide-react\`)`,
// and the sub-path forms (`lucide-react/dist/...`).
const ICON_PACKAGE_MOCK =
  /\b(?:vi|jest)\s*\.\s*(?:do)?[mM]ock\s*\(\s*['"`]lucide-react(?:\/[^'"`]*)?['"`]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (TEST_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const testFiles = walk(SCAN_ROOT);
const offenders = testFiles
  .filter((file) => ICON_PACKAGE_MOCK.test(readFileSync(file, 'utf8')))
  .map((file) => relative(REPO_ROOT, file))
  .sort();

describe('web tests render lucide-react icons, never a hand-written mock of the package', () => {
  it('scans a non-empty test-file surface', () => {
    expect(testFiles.length).toBeGreaterThan(100); // sanity: the scan actually ran
  });

  it('no test file mocks the lucide-react package', () => {
    expect(offenders).toEqual([]);
  });

  it('the detector reads every mock spelling', () => {
    for (const sample of [
      "vi.mock('lucide-react', () => ({}));",
      'vi.mock("lucide-react");',
      'vi.doMock(`lucide-react`, factory);',
      "jest.mock('lucide-react/dist/esm/icons/house');",
      "vi.mock(\n  'lucide-react',\n  () => ({}),\n);",
    ]) {
      expect(ICON_PACKAGE_MOCK.test(sample)).toBe(true);
    }
    expect(ICON_PACKAGE_MOCK.test("vi.mock('../components/icons', () => ({}));")).toBe(false);
    expect(ICON_PACKAGE_MOCK.test("import { House } from 'lucide-react';")).toBe(false);
  });
});
