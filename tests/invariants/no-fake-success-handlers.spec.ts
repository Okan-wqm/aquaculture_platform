/**
 * INVARIANT: a failed action is never rendered as a successful one.
 *
 * # The defect this catches
 *
 * `DebugToolsPage` had two destructive controls whose catch blocks read:
 *
 *     } catch (err) {
 *       console.error('Failed to clear cache:', err);
 *       // Mock success for demo
 *       setShowClearConfirm(false);
 *       setTimeout(() => loadCacheData(), 500);
 *     }
 *
 * and
 *
 *     } catch (err) {
 *       console.error('Failed to invalidate cache entry:', err);
 *       // Mock success for demo
 *       setCacheEntries(cacheEntries.filter((e) => e.key !== key));
 *     }
 *
 * On failure the first closed the confirmation dialog and scheduled a refresh;
 * the second removed the row from local state. Both are exactly what a SUCCESS
 * looks like. A SUPER_ADMIN clearing cache during an incident saw the dialog
 * close and the row vanish whether or not anything had happened — and in
 * production, where nginx 404s `/api/debug`, nothing ever had.
 *
 * The demo-era marker is what makes this catchable. Its presence is a
 * confession, and a grep for it is a complete rule for the class it names.
 *
 * # What is enforced
 *
 * No web module may carry a "mock success" / "fake success" marker. The honest
 * shapes are: surface the error, leave the optimistic state alone, and — where
 * the backend returns a count — render it, so a control that stops working
 * reports zero instead of looking the same as one that works.
 *
 * # Scope
 *
 * `web/**` source only. A backend mock lives in a spec file, which is where a
 * mock belongs; this rule is about what a USER is shown.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Source under `web/`, excluding tests — a spec may legitimately mock. */
function webSourceFiles(): string[] {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'web/**/src/**/*.ts', 'web/**/src/**/*.tsx'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter(
      (rel) =>
        rel.length > 0 &&
        !rel.includes('/__tests__/') &&
        !rel.endsWith('.spec.ts') &&
        !rel.endsWith('.spec.tsx') &&
        !rel.endsWith('.test.ts') &&
        !rel.endsWith('.test.tsx'),
    );
}

/**
 * The confession, as a comment that IS the marker.
 *
 * Anchored to the start of the comment on purpose. Prose that merely mentions
 * the phrase — this file's own docblock quoting `// Mock success for demo`, or
 * farm-module's three `// it — NEVER fake success.` reminders — is the rule
 * being described or upheld, not broken. A grep that flagged those would make
 * the rule unstatable in its own words, and the first fix would be to soften
 * the comment rather than the code.
 */
const FAKE_SUCCESS_MARKER =
  /^\s*(?:\/\/|\*)\s*(?:mock|fake|simulate[d]?|pretend)(?:ing)?\s+success\b/i;

describe('INVARIANT: no handler fakes success on failure', () => {
  const files = webSourceFiles();

  it('finds the web sources to check', () => {
    // Guards against the pathspec silently matching nothing.
    expect(files.length).toBeGreaterThan(200);
  });

  it('no web module claims success for an action that failed', () => {
    const offenders: string[] = [];

    for (const rel of files) {
      readFileSync(resolve(REPO_ROOT, rel), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (FAKE_SUCCESS_MARKER.test(line)) {
            offenders.push(`${rel}:${index + 1}  ${line.trim()}`);
          }
        });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} site(s) mark a handler as faking success.\n` +
          `A failed action must read as failed: surface the error, leave optimistic\n` +
          `state in place, and render the count the backend returned so a control\n` +
          `that stopped working looks different from one that works.\n\n` +
          offenders.join('\n'),
      );
    }
  });

  it('no catch block on the cache pages performs the success gesture', () => {
    // The marker is a lexical tell, and a tell can be deleted without fixing
    // anything. This asserts the SHAPE it used to sit beside: closing the
    // confirmation dialog, or filtering the row out of local state, from inside
    // a catch. Both of those ARE the success path; performing them on failure
    // is what made a dead control indistinguishable from a working one.
    const SUCCESS_GESTURE = /setShowClearConfirm\(false\)|setConfirmClear\(false\)|\.filter\(/;
    const offenders: string[] = [];

    for (const rel of [
      'web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx',
      'web/modules/admin-panel/src/pages/AdminDashboard.tsx',
    ]) {
      const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      for (const match of source.matchAll(/\} catch \([^)]*\) \{([\s\S]*?)\n(\s*)\} finally|\} catch \([^)]*\) \{([\s\S]*?)\n\s*\}\n/g)) {
        const body = match[1] ?? match[3] ?? '';
        if (SUCCESS_GESTURE.test(body)) offenders.push(`${rel}: ${body.trim().slice(0, 120)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the cache controls read the count the backend returned', () => {
    // The positive half of the rule. Deleting the marker while still ignoring
    // the response would satisfy the grep and leave the defect: the endpoint
    // reported `{invalidated: 0}` for two years and no caller ever looked.
    for (const rel of [
      'web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx',
      'web/modules/admin-panel/src/pages/AdminDashboard.tsx',
    ]) {
      const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(source).toMatch(/result\.invalidated/);
    }
  });
});
