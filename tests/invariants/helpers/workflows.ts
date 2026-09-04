/**
 * Workflow reference scanners — shared SSoT for the invariants that read
 * `.github/workflows/*.yml` and ask what a step invokes: an `npm run` script,
 * an Nx target fan-out, a spec path.
 *
 * One home (2026-09-04, INFRA-HIGH-141 / INFRA-MEDIUM-142): the npm-script and
 * Nx-target resolvers grew up inside workflow-npm-script-references.spec.ts;
 * claude-md-accuracy.spec.ts now needs the same "which scripts does CI run"
 * answer to decide whether a steering file's cited spec is executed anywhere.
 * A second copy of the line iteration would be exactly the drift this suite
 * exists to catch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** `npm run <name>`, with npm's own flags allowed in between. */
export const NPM_RUN = /npm(?:\s+(?:--\S+|-\w+)(?:[=\s]\S+)?)*\s+run\s+([A-Za-z0-9:_.-]+)/g;

/** Script names npm itself defines; not expected in any manifest. */
const NPM_BUILTIN_SCRIPT_ARGS = new Set(['scripts', 'env']);

export function trackedPackageManifests(): string[] {
  const out = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split(/\r?\n/).filter((rel) => rel.trim() && !rel.includes('node_modules/'));
}

export function declaredScriptNames(): Set<string> {
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

export interface Reference {
  readonly workflow: string;
  readonly line: number;
  readonly script: string;
}

export function workflowScriptReferences(): Reference[] {
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

export interface TargetReference {
  readonly workflow: string;
  readonly line: number;
  readonly target: string;
  /** Set for `nx run <project>:<target>`; the project must declare the target. */
  readonly project?: string;
}

/** `affected-target-policy.sh --target <name>` — the policy script's own contract. */
export const POLICY_TARGET = /affected-target-policy\.sh --target ([A-Za-z0-9:_-]+)/g;
/** `nx affected|run-many … -t <name>` / `--target=<name>` / `--target <name>`, on one logical line. */
export const NX_TARGET_FLAG =
  /\bnx\s+(?:affected|run-many)\b[^\n]*?(?:--target[= ]|\s-t[= ])([A-Za-z0-9:_-]+)/g;
/** `nx run <project>:<target>`. */
export const NX_RUN = /\bnx\s+run\s+([A-Za-z0-9@/._-]+):([A-Za-z0-9:_-]+)/g;

/**
 * Shell continuation lines (`… \`) folded into the line that started them, so
 * `nx run-many \` + `--target=build \` is seen as one command. Each logical
 * line keeps the number of its first physical line.
 */
export function logicalLines(
  lines: readonly string[],
): ReadonlyArray<{ line: number; text: string }> {
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

export function workflowTargetReferences(): TargetReference[] {
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

/**
 * Every non-comment logical line of every workflow, with continuation lines
 * folded — the surface a "does any workflow name this path" question reads.
 */
export function workflowRunLines(): ReadonlyArray<{
  readonly workflow: string;
  readonly line: number;
  readonly text: string;
}> {
  const out: { workflow: string; line: number; text: string }[] = [];
  for (const file of readdirSync(WORKFLOW_DIR).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const physical = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split('\n');
    for (const { line, text } of logicalLines(physical)) {
      if (/^\s*#/.test(text)) continue;
      out.push({ workflow: file, line, text });
    }
  }
  return out;
}
