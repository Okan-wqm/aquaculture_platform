/**
 * The ARIA authority surface — derived where it is read, never recorded.
 *
 * WHAT THIS MODULE ANSWERS
 *
 *   1. `ariaAuthorityHash(repoRoot, rev)` — a SHA-256 over every authority path
 *      (`docs/aria/`, `aria-kernel/`, `tools/aria-poc/`, `.github/workflows/aria-*`)
 *      in one commit's tree: path, mode and blob id. It is a pure function of
 *      that tree, so anyone who needs "which authority surface was this?" asks
 *      for the commit and derives the value; nothing stores it.
 *   2. `checkCurrentState(repoRoot)` — does `docs/aria/CURRENT_STATE.md` still
 *      describe the tree it sits in? Every repository path in its
 *      `## Current Normative Anchors` section must be a tracked file (or, ending
 *      in `/`, a tracked directory), every `file.py::symbol` anywhere in it must
 *      name a top-level definition of that module, and it must record no
 *      SHA-256-shaped digest. The docs SSoT invariant and `--check` both consume
 *      this one verdict, so they cannot disagree.
 *
 * WHY (PROC-HIGH-046). Until 2026-10-02 the digest was COMMITTED as a line of
 * CURRENT_STATE and compared with a fresh computation. The pre-commit hook
 * rewrote it on every commit that staged an ARIA path and the post-merge hook
 * after every merge, so every ARIA PR rewrote the same line: 17 of 17 ARIA
 * merges on main in the fortnight before did, and each one left every other
 * open ARIA PR stale. The value certified that a hook had run, not that anyone
 * had read the document; the only event it failed on was a merge combining two
 * authority changes, which is not a documentation defect. What actually makes
 * the document falsifiable is the set of claims it makes about the tree — its
 * anchors — and those are checked against the tree directly. A module rename
 * that leaves an anchor dangling is the "runtime has moved" case the pin was
 * meant to catch, and it now fails naming the anchor instead of a digest.
 *
 * CLI:
 *   ts-node tools/gates/aria-authority-hash.ts [<rev>]   # print the digest (default HEAD)
 *   ts-node tools/gates/aria-authority-hash.ts --check   # CURRENT_STATE verdict, exit 0/1
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CURRENT_STATE_PATH = 'docs/aria/CURRENT_STATE.md';

/** The heading whose backticked repository paths are the document's claims. */
export const NORMATIVE_ANCHORS_HEADING = '## Current Normative Anchors';

const AUTHORITY_ROOTS = ['docs/aria', 'aria-kernel', 'tools/aria-poc'] as const;
const AUTHORITY_WORKFLOW = /^\.github\/workflows\/aria-[^/]+\.ya?ml$/;

/** A recorded digest of anything goes stale the moment its input moves. */
const RECORDED_DIGEST = /\b[a-f0-9]{64}\b/;

/** A backticked repository path, optionally carrying a `::symbol` owner. */
const BACKTICKED_PATH = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)(?:::([A-Za-z_]\w*))?`/g;

/** `file.py::symbol` anywhere in the document. */
const PYTHON_SYMBOL = /([\w./-]+\.py)::([A-Za-z_]\w*)/g;

/**
 * Git with none of the GIT_* variables a hook exports: the pre-commit hook runs
 * the gate specs with GIT_INDEX_FILE pointing at the host repository's index,
 * and a `git -C <fixture> ls-files` under that variable would read the host.
 */
function gitIn(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  });
}

export function ariaRepoRoot(): string {
  try {
    return gitIn(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return process.cwd();
  }
}

export interface AuthorityEntry {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
}

/** Every authority path in `rev`'s tree, sorted by path. */
export function ariaAuthorityEntries(repoRoot: string, rev = 'HEAD'): AuthorityEntry[] {
  const raw = gitIn(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    rev,
    '--',
    ...AUTHORITY_ROOTS,
    '.github/workflows',
  ]);
  const entries: AuthorityEntry[] = [];
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob' || mode === undefined || blob === undefined) continue;
    if (path.startsWith('.github/') && !AUTHORITY_WORKFLOW.test(path)) continue;
    entries.push({ path, mode, blob });
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** The authority digest of `rev`: deterministic for a given tree, stored nowhere. */
export function ariaAuthorityHash(repoRoot: string = ariaRepoRoot(), rev = 'HEAD'): string {
  const hash = createHash('sha256');
  for (const entry of ariaAuthorityEntries(repoRoot, rev)) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.blob}\0`);
  }
  return hash.digest('hex');
}

export interface PathAnchor {
  readonly path: string;
  readonly line: number;
}

export interface SymbolAnchor {
  readonly path: string;
  readonly symbol: string;
  readonly line: number;
}

export interface CurrentStateAnchors {
  readonly sectionFound: boolean;
  readonly paths: readonly PathAnchor[];
  readonly symbols: readonly SymbolAnchor[];
}

/**
 * Paths come from the normative-anchor section only: elsewhere the document
 * also names paths it declares INVALID (repo-local shadow roots), and those
 * are not claims that the path exists. A `::symbol` is a claim wherever it
 * appears.
 */
export function currentStateAnchors(body: string): CurrentStateAnchors {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === NORMATIVE_ANCHORS_HEADING);
  const paths: PathAnchor[] = [];
  if (start !== -1) {
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (line.startsWith('## ')) break;
      for (const match of line.matchAll(BACKTICKED_PATH)) {
        const path = match[1];
        if (path !== undefined && path.includes('/')) paths.push({ path, line: index + 1 });
      }
    }
  }
  const symbols: SymbolAnchor[] = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(PYTHON_SYMBOL)) {
      const [, path, symbol] = match;
      if (path !== undefined && symbol !== undefined)
        symbols.push({ path, symbol, line: index + 1 });
    }
  });
  return { sectionFound: start !== -1, paths, symbols };
}

export type CurrentStateDefect =
  | { readonly kind: 'recorded_authority_digest'; readonly line: number }
  | { readonly kind: 'normative_anchors_missing' }
  | { readonly kind: 'unresolved_path'; readonly anchor: string; readonly line: number }
  | { readonly kind: 'unresolved_symbol'; readonly anchor: string; readonly line: number };

export interface CurrentStateVerdict {
  readonly valid: boolean;
  readonly pathAnchors: number;
  readonly symbolAnchors: number;
  readonly defects: readonly CurrentStateDefect[];
}

/**
 * Same rule the docs invariant used inline: a module-level def, async def,
 * class, assignment or annotated assignment of that name. One interpreter for
 * every anchor; prints the indexes that do not resolve.
 */
const PYTHON_RESOLVER = [
  'import ast, json, sys',
  'missing = []',
  'for index, (path, symbol) in enumerate(json.load(sys.stdin)):',
  '    try:',
  '        tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)',
  '    except (OSError, SyntaxError, UnicodeDecodeError):',
  '        missing.append(index)',
  '        continue',
  '    found = False',
  '    for node in tree.body:',
  '        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:',
  '            found = True',
  '        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == symbol for t in node.targets):',
  '            found = True',
  '        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == symbol:',
  '            found = True',
  '    if not found:',
  '        missing.append(index)',
  'json.dump(missing, sys.stdout)',
].join('\n');

function unresolvedSymbols(repoRoot: string, symbols: readonly SymbolAnchor[]): Set<number> {
  if (symbols.length === 0) return new Set();
  const out = execFileSync('python3', ['-c', PYTHON_RESOLVER], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: JSON.stringify(symbols.map((anchor) => [join(repoRoot, anchor.path), anchor.symbol])),
  });
  return new Set(JSON.parse(out) as number[]);
}

function firstBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** The verdict over the checked-out tree: tracked paths from the index, content from disk. */
export function checkCurrentState(repoRoot: string = ariaRepoRoot()): CurrentStateVerdict {
  const body = readFileSync(join(repoRoot, CURRENT_STATE_PATH), 'utf8');
  const anchors = currentStateAnchors(body);
  const defects: CurrentStateDefect[] = [];

  const digestLine = body.split(/\r?\n/).findIndex((line) => RECORDED_DIGEST.test(line));
  if (digestLine !== -1) defects.push({ kind: 'recorded_authority_digest', line: digestLine + 1 });
  if (!anchors.sectionFound) defects.push({ kind: 'normative_anchors_missing' });

  const tracked = gitIn(repoRoot, ['ls-files', '-z'])
    .split('\0')
    .filter((rel) => rel !== '' && existsSync(join(repoRoot, rel)));
  const trackedFiles = new Set(tracked);
  const resolves = (path: string): boolean =>
    path.endsWith('/') ? tracked.some((rel) => rel.startsWith(path)) : trackedFiles.has(path);

  const paths = firstBy(anchors.paths, (anchor) => anchor.path);
  for (const anchor of paths) {
    if (!resolves(anchor.path)) {
      defects.push({ kind: 'unresolved_path', anchor: anchor.path, line: anchor.line });
    }
  }

  const symbols = firstBy(anchors.symbols, (anchor) => `${anchor.path}::${anchor.symbol}`);
  const present = symbols.filter((anchor) => trackedFiles.has(anchor.path));
  const missing = unresolvedSymbols(repoRoot, present);
  for (const anchor of symbols) {
    const index = present.indexOf(anchor);
    if (index === -1 || missing.has(index)) {
      defects.push({
        kind: 'unresolved_symbol',
        anchor: `${anchor.path}::${anchor.symbol}`,
        line: anchor.line,
      });
    }
  }

  return {
    valid: defects.length === 0,
    pathAnchors: paths.length,
    symbolAnchors: symbols.length,
    defects,
  };
}

function describeDefect(defect: CurrentStateDefect): string {
  switch (defect.kind) {
    case 'recorded_authority_digest':
      return `line ${defect.line}: records a SHA-256-shaped digest; derive it instead (npm run aria:authority-hash -- <rev>)`;
    case 'normative_anchors_missing':
      return `no '${NORMATIVE_ANCHORS_HEADING}' section`;
    case 'unresolved_path':
      return `line ${defect.line}: ${defect.anchor} is not a tracked path`;
    case 'unresolved_symbol':
      return `line ${defect.line}: ${defect.anchor} is not a module-level definition`;
  }
}

function main(argv: readonly string[]): number {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (flags.includes('--write')) {
    process.stderr.write(
      'aria authority hash: nothing to write — the digest is derived from a commit on demand\n' +
        '  and recorded nowhere (PROC-HIGH-046). Print it with `npm run aria:authority-hash -- <rev>`.\n',
    );
    return 2;
  }
  if (flags.some((flag) => flag !== '--check') || positional.length > 1) {
    process.stderr.write('usage: aria-authority-hash.ts [<rev>] | --check\n');
    return 2;
  }
  const repoRoot = ariaRepoRoot();
  if (flags.includes('--check')) {
    const verdict = checkCurrentState(repoRoot);
    if (verdict.valid) {
      process.stdout.write(
        `CURRENT_STATE: ${verdict.pathAnchors} path anchor(s) and ${verdict.symbolAnchors} ` +
          'symbol anchor(s) resolve; no recorded digest.\n',
      );
      return 0;
    }
    process.stderr.write(
      `CURRENT_STATE no longer describes this tree (${CURRENT_STATE_PATH}):\n` +
        verdict.defects.map((defect) => `  - ${describeDefect(defect)}\n`).join('') +
        '  Update the document to name what the tree has; the anchors are its claims.\n',
    );
    return 1;
  }
  process.stdout.write(`${ariaAuthorityHash(repoRoot, positional[0] ?? 'HEAD')}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
