/**
 * INVARIANT (console a11y review, 2026-10-16): the shell owns the page's
 * `main` and `banner` landmarks; no federated page adds its own.
 *
 * WHY: every module page renders inside a shell frame that already draws them
 * — the tenant console's header (the banner) and `<main id="main-content">`
 * (ConsoleShell), the admin console's Header and main (AdminConsole). A page
 * that wrote its own `<main>` nested one main inside another (invalid HTML)
 * and gave assistive technology two main landmarks; `role="banner"` on a
 * page's toolbar gave it two banners. Screen-reader users jump between
 * landmarks, so a second one sends them to the wrong place. Review found
 * three: VfdProgrammingPage and farm EnvironmentPage nested a `<main>`, and
 * the SCADA operator view (OperatorShell / OperatorHeader, mounted under
 * /sensor/scada/operator/:packageId) added a main and a banner.
 *
 * RULE: no `.tsx` source under web/modules writes a `<main>` element or the
 * `banner` / `main` role. A `<header>` inside the page stays allowed — inside
 * `<main>` it is a section header, not a landmark. Comments are ignored, so a
 * comment may name the element it explains.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'web/modules');
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '__mocks__', '__fixtures__']);

/** A JSX `<main …>` element, or a `banner` / `main` role in any quoting. */
const SHELL_LANDMARK = /<main[\s>/]|\brole=(?:"|'|\{['"])(?:banner|main)\b/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sources(full));
    } else if (entry.endsWith('.tsx') && !/\.(spec|test)\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The source without its comments: block and JSX comments, and `//` line comments. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('INVARIANT: the shell owns the main and banner landmarks', () => {
  const files = sources(SCAN_ROOT);

  it('scans every federated module', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const module of ['farm-module', 'sensor-module', 'hr-module', 'admin-panel'])
      expect(files.some((file) => relative(SCAN_ROOT, file).startsWith(`${module}/`))).toBe(true);
  });

  it('no module page writes a <main> element or a banner / main role', () => {
    const offenders = files
      .filter((file) => SHELL_LANDMARK.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the rule catches what it names, and lets a comment or a header through', () => {
    expect(SHELL_LANDMARK.test(code('<main className="p-4">'))).toBe(true);
    expect(SHELL_LANDMARK.test(code('<main>'))).toBe(true);
    expect(SHELL_LANDMARK.test(code('<header role="banner">'))).toBe(true);
    expect(SHELL_LANDMARK.test(code("<div role='main'>"))).toBe(true);
    expect(SHELL_LANDMARK.test(code("<div role={'banner'}>"))).toBe(true);
    expect(SHELL_LANDMARK.test(code('{/* the shell <main> holds it */}'))).toBe(false);
    expect(SHELL_LANDMARK.test(code('// inside <main>, a section header'))).toBe(false);
    expect(SHELL_LANDMARK.test(code('<header className="border-b">'))).toBe(false);
    expect(SHELL_LANDMARK.test(code('<mainframe-panel />'))).toBe(false);
  });
});
