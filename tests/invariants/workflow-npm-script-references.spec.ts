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
 *
 * NX TARGETS ARE THE SAME SEAM (2026-09-04, INFRA-HIGH-141). A workflow step
 * that fans out over an Nx target (`affected-target-policy.sh --target X`,
 * `nx affected -t X`, `nx run-many --target=X`, `nx run <project>:<target>`)
 * references a declaration that lives in some project.json or package.json —
 * or in none. `ci-affected.yml` carried `--target test:invariant` and
 * `-t type-check` for months; no project declared either, Nx resolved each to
 * an empty set, and the steps were green without running anything. The target
 * references below are resolved through the project graph itself
 * (helpers/nx.ts), because a static scan would re-implement Nx's inference.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { nxProjects, nxProjectsWithTarget } from './helpers/nx';

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
  return out.split(/\r?\n/).filter((rel) => rel.trim() && !rel.includes('node_modules/'));
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

interface TargetReference {
  readonly workflow: string;
  readonly line: number;
  readonly target: string;
  /** Set for `nx run <project>:<target>`; the project must declare the target. */
  readonly project?: string;
}

/** `affected-target-policy.sh --target <name>` — the policy script's own contract. */
const POLICY_TARGET = /affected-target-policy\.sh --target ([A-Za-z0-9:_-]+)/g;
/** `nx affected|run-many … -t <name>` / `--target=<name>` / `--target <name>`, on one logical line. */
const NX_TARGET_FLAG =
  /\bnx\s+(?:affected|run-many)\b[^\n]*?(?:--target[= ]|\s-t[= ])([A-Za-z0-9:_-]+)/g;
/** `nx run <project>:<target>`. */
const NX_RUN = /\bnx\s+run\s+([A-Za-z0-9@/._-]+):([A-Za-z0-9:_-]+)/g;

/**
 * Shell continuation lines (`… \`) folded into the line that started them, so
 * `nx run-many \` + `--target=build \` is seen as one command. Each logical
 * line keeps the number of its first physical line.
 */
function logicalLines(lines: readonly string[]): ReadonlyArray<{ line: number; text: string }> {
  const out: { line: number; text: string }[] = [];
  let current: { line: number; text: string } | undefined;
  lines.forEach((raw, index) => {
    if (current !== undefined) {
      current.text += ` ${raw.trim()}`;
    } else {
      current = { line: index + 1, text: raw };
    }
    if (current.text.endsWith('\\')) {
      current.text = current.text.slice(0, -1);
      return;
    }
    out.push(current);
    current = undefined;
  });
  if (current !== undefined) out.push(current);
  return out;
}

function workflowTargetReferences(): TargetReference[] {
  const refs: TargetReference[] = [];
  for (const file of readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const physical = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split('\n');
    for (const { line, text } of logicalLines(physical)) {
      if (/^\s*#/.test(text)) continue;
      for (const match of text.matchAll(POLICY_TARGET)) {
        const target = match[1];
        if (target) refs.push({ workflow: file, line, target });
      }
      for (const match of text.matchAll(NX_TARGET_FLAG)) {
        const target = match[1];
        if (target) refs.push({ workflow: file, line, target });
      }
      for (const match of text.matchAll(NX_RUN)) {
        const project = match[1];
        const target = match[2];
        if (project && target) refs.push({ workflow: file, line, target, project });
      }
    }
  }
  return refs;
}

describe('workflow Nx target references', () => {
  it('finds Nx target fan-outs to check, so a silent regex break is visible', () => {
    expect(workflowTargetReferences().length).toBeGreaterThan(5);
  });

  it('resolves every referenced Nx target to at least one declaring project', () => {
    const phantom = workflowTargetReferences().filter(
      (ref) => nxProjectsWithTarget(ref.target).length === 0,
    );

    expect(phantom.map((r) => `${r.workflow}:${r.line} -> target ${r.target}`)).toEqual([]);
  });

  it('resolves every `nx run <project>:<target>` to a project that declares that target', () => {
    const workspace = new Set(nxProjects());
    const broken = workflowTargetReferences().filter((ref) => {
      if (ref.project === undefined) return false;
      if (!workspace.has(ref.project)) return true;
      return !nxProjectsWithTarget(ref.target).includes(ref.project);
    });

    expect(
      broken.map((r) => `${r.workflow}:${r.line} -> nx run ${r.project ?? ''}:${r.target}`),
    ).toEqual([]);
  });
});

describe('workflow npm script references', () => {
  it('finds npm run invocations to check, so a silent regex break is visible', () => {
    // Guards the guard: if NPM_RUN stopped matching, every assertion below would
    // pass over an empty set and report health it never verified.
    expect(workflowScriptReferences().length).toBeGreaterThan(5);
  });

  it('resolves every referenced script to a declared package script', () => {
    const declared = declaredScriptNames();
    expect(declared.size).toBeGreaterThan(50);

    const orphaned = workflowScriptReferences().filter((ref) => !declared.has(ref.script));

    expect(orphaned.map((r) => `${r.workflow}:${r.line} -> npm run ${r.script}`)).toEqual([]);
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
