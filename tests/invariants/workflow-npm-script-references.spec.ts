/**
 * Every `npm run <script>` a workflow invokes must exist somewhere.
 *
 * WHY THIS EXISTS: a workflow step calling `npm run gates:finding-registry:test`
 * was added in the same change as the script it calls. A later, unrelated revert
 * of `package.json` — reverting dependency edits — took the script with it and
 * left the step behind. The job died with `npm error Missing script`, and nothing
 * caught it before push: the script's own test passed, type-check passed, the
 * gate it guarded passed. The break lived in the seam between two files that no
 * check read together.
 *
 * That seam is generic. Any narrow revert, rename, or script cleanup can orphan a
 * workflow reference, and the failure always surfaces as a red CI job with a
 * message that reads like tooling trouble rather than a missing declaration.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not resolve working directories.
 * Workflows legitimately invoke scripts from other package.json files — via
 * `--workspace`, via `--prefix`, or by `cd`-ing inside a shell block or an SSH
 * heredoc — and statically resolving which manifest applies would need a shell
 * interpreter. So the assertion is the weaker, still-useful one: the script name
 * must exist in SOME package.json in the repository. A name that exists nowhere
 * cannot be correct under any working directory, and that is exactly the class of
 * defect this was written after.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** `npm run <name>`, with npm's own flags allowed in between. */
const NPM_RUN = /npm(?:\s+(?:--\S+|-\w+)(?:[=\s]\S+)?)*\s+run\s+([A-Za-z0-9:_.-]+)/g;

/** Script names npm itself defines; not expected in any manifest. */
const NPM_BUILTIN_SCRIPT_ARGS = new Set(['scripts', 'env']);

function trackedPackageManifests(): string[] {
  const out = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split(/\r?\n/)
    .filter((rel) => rel.trim() && !rel.includes('node_modules/'));
}

function declaredScriptNames(): Set<string> {
  const names = new Set<string>();
  for (const rel of trackedPackageManifests()) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    let parsed: { scripts?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8')) as typeof parsed;
    } catch {
      continue; // A malformed manifest is a different invariant's problem.
    }
    for (const name of Object.keys(parsed.scripts ?? {})) names.add(name);
  }
  return names;
}

interface Reference {
  readonly workflow: string;
  readonly line: number;
  readonly script: string;
}

function workflowScriptReferences(): Reference[] {
  const refs: Reference[] = [];
  for (const file of readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      // A comment describing a command is not an invocation. `npm run` appears
      // in explanatory comments in at least two workflows here.
      if (/^\s*#/.test(line)) return;
      for (const match of line.matchAll(NPM_RUN)) {
        const script = match[1];
        if (!script || NPM_BUILTIN_SCRIPT_ARGS.has(script)) continue;
        refs.push({ workflow: file, line: index + 1, script });
      }
    });
  }
  return refs;
}

describe('workflow npm script references', () => {
  it('finds npm run invocations to check, so a silent regex break is visible', () => {
    // Guards the guard: if NPM_RUN stopped matching, every assertion below would
    // pass over an empty set and report health it never verified.
    expect(workflowScriptReferences().length).toBeGreaterThan(5);
  });

  it('resolves every referenced script to a declared package script', () => {
    const declared = declaredScriptNames();
    expect(declared.size).toBeGreaterThan(50);

    const orphaned = workflowScriptReferences().filter(
      (ref) => !declared.has(ref.script),
    );

    expect(orphaned.map((r) => `${r.workflow}:${r.line} -> npm run ${r.script}`)).toEqual(
      [],
    );
  });

  it('keeps the gate self-tests this repo runs in CI declared', () => {
    // Named explicitly because these two are the ones that were orphaned, and
    // because they are the tests that pin the finding-ID allocator and the
    // Closes: trailer resolver against each other.
    const declared = declaredScriptNames();
    for (const script of ['gates:commit-msg:test', 'gates:finding-registry:test']) {
      expect(declared.has(script)).toBe(true);
    }
  });
});
