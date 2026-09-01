#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const lintAllDocs = process.argv.slice(2).includes('--all');
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MARKDOWNLINT_CHANGED_LANE_MAX_BUFFER = 8 * 1024 * 1024;
const MARKDOWNLINT_BOOTSTRAP_MAX_JSON_BYTES = 32 * 1024 * 1024;
// E17-a — GENERATED docs are excluded from prose linting. A generated
// artifact reproduces its SSoT sources byte-for-byte (docs/aria/generated/
// JUDGE-DIGEST.md is extracted from SPEC/CONTRACTS/PIPELINES and pinned
// byte-for-byte by an invariant); re-wrapping it to satisfy MD013 would
// either break that identity or force the wrap back into the SSoT for a
// reason the SSoT does not share. Prose rules measure prose a human
// wrote; nobody writes these files.
const docsPathspecs = [
  ':(glob)docs/*.md',
  ':(glob)docs/**/*.md',
  ':(glob,exclude)docs/**/generated/**/*.md',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function resolveCommit(ref, role) {
  const result = run('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(`markdownlint ${role} ${ref} cannot be resolved: ${result.stderr.trim()}`);
  }

  const oid = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new Error(`markdownlint ${role} ${ref} resolved to an invalid object id`);
  }
  return oid;
}

function resolveBaseRef(ref) {
  if (ref !== EMPTY_TREE_OID) return resolveCommit(ref, 'base');

  const result = run('git', ['cat-file', '-e', `${EMPTY_TREE_OID}^{tree}`]);
  if (result.status !== 0) {
    throw new Error(
      `markdownlint base ${EMPTY_TREE_OID} cannot be resolved: ${result.stderr.trim()}`,
    );
  }
  return EMPTY_TREE_OID;
}

function diffRange(baseRef, headRef) {
  return baseRef === EMPTY_TREE_OID ? [baseRef, headRef] : [`${baseRef}...${headRef}`];
}

function parseChangedDocs(stdout) {
  const files = new Set();
  for (const file of stdout.split('\0')) {
    if (file.length === 0 || !file.endsWith('.md')) continue;
    const absolutePath = resolve(repoRoot, file);
    const relativePath = relative(repoRoot, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`markdownlint changed path escapes the repository: ${JSON.stringify(file)}`);
    }
    if (existsSync(absolutePath)) files.add(file);
  }
  return [...files].sort();
}

function changedDocs(baseRef, headRef) {
  const baseOid = resolveBaseRef(baseRef);
  const headOid = resolveCommit(headRef, 'head');
  const args = [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACMRT',
    ...diffRange(baseOid, headOid),
    '--',
    ...docsPathspecs,
  ];
  const result = run('git', args);
  if (result.status !== 0) {
    throw new Error(
      `markdownlint range ${diffRange(baseOid, headOid).join(' ')} cannot be inspected: ${result.stderr.trim()}`,
    );
  }
  return parseChangedDocs(result.stdout);
}

function changedWorkingTreeDocs() {
  const result = run('git', [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACMRT',
    'HEAD',
    '--',
    ...docsPathspecs,
  ]);
  if (result.status !== 0) {
    throw new Error(`markdownlint working tree cannot be inspected: ${result.stderr.trim()}`);
  }
  return parseChangedDocs(result.stdout);
}

/**
 * The lines this change actually wrote, per file, from `git diff -U0`.
 *
 * Without a range (local working-tree lane) every line counts as "yours" —
 * the caller has no base to be innocent against.
 */
function addedLineRanges(file, baseRef, headRef) {
  const args = baseRef
    ? ['diff', '-U0', ...diffRange(baseRef, headRef), '--', file]
    : ['diff', '-U0', 'HEAD', '--', file];
  const result = run('git', args);
  if (result.status !== 0) {
    return null; // unknown range → bill everything, never silently pass
  }
  const ranges = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/**
 * Keep only findings on lines this change wrote.
 *
 * WHY: a gate must not bill a PR for debt it did not create. markdownlint
 * lints whole files, so touching one comment line in a 70KB contract doc
 * used to surface hundreds of pre-existing MD013/MD040 violations and block
 * the PR — the author's only "fixes" being to reflow prose they never wrote
 * (churn that risks the very SSoT the doc is). This mirrors the format
 * gate's existing base-debt quarantine: new lines are enforced, inherited
 * debt is reported and attributed, never billed.
 */
function keepFindingsOnChangedLines(stderr, changedFiles, baseRef, headRef) {
  const rangesByFile = new Map();
  for (const file of changedFiles) {
    rangesByFile.set(file, addedLineRanges(file, baseRef, headRef));
  }
  const kept = [];
  // A finding's message can wrap onto further lines when its [Context: "…"]
  // quotes text containing a newline. A continuation is not an independent
  // finding: it belongs to the decision already made for its parent, and
  // treating it as unparseable would bill a PR for the inherited violation
  // the parent line was just excused from.
  let lastParsedWasKept = true;
  for (const line of stderr.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([^:]+):(\d+)(?::\d+)?\s/.exec(line);
    if (!match) {
      if (lastParsedWasKept) {
        kept.push(line); // unparseable, or a kept finding's continuation
      }
      continue;
    }
    const [, file, lineNumber] = match;
    const ranges = rangesByFile.get(file);
    if (ranges === undefined || ranges === null) {
      kept.push(line);
      lastParsedWasKept = true;
      continue;
    }
    const number = Number(lineNumber);
    const billed = ranges.some(([start, end]) => number >= start && number <= end);
    if (billed) {
      kept.push(line);
    }
    lastParsedWasKept = billed;
  }
  return kept;
}

function bootstrapLintSummary(result, outputPath, changedFiles) {
  if (result.status !== 0 && result.status !== 1) {
    return {
      reason: `unexpected linter status ${result.status ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
    };
  }
  if (result.stdout || result.stderr) {
    return { reason: 'unexpected markdownlint stdout or stderr' };
  }
  if (!existsSync(outputPath)) {
    return { reason: 'missing markdownlint JSON output' };
  }

  const outputSize = statSync(outputPath).size;
  if (result.status === 0) {
    return outputSize === 0
      ? { findingCount: 0, fileCount: 0, rules: [] }
      : { reason: 'status 0 with non-empty JSON output' };
  }
  if (outputSize === 0) {
    return { reason: 'status 1 with empty JSON output' };
  }
  if (outputSize > MARKDOWNLINT_BOOTSTRAP_MAX_JSON_BYTES) {
    return { reason: `JSON output exceeds ${MARKDOWNLINT_BOOTSTRAP_MAX_JSON_BYTES} bytes` };
  }

  let findings;
  try {
    findings = JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch {
    return { reason: 'malformed markdownlint JSON output' };
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    return { reason: 'status 1 without a non-empty findings array' };
  }

  const expectedFiles = new Set(changedFiles);
  const findingFiles = new Set();
  const rules = new Set();
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      return { reason: 'malformed markdownlint finding' };
    }
    const { fileName, lineNumber, ruleNames } = finding;
    if (
      typeof fileName !== 'string' ||
      !fileName.startsWith('docs/') ||
      !expectedFiles.has(fileName) ||
      !Number.isInteger(lineNumber) ||
      lineNumber <= 0 ||
      !Array.isArray(ruleNames) ||
      typeof ruleNames[0] !== 'string' ||
      !/^MD\d{3}$/.test(ruleNames[0])
    ) {
      return { reason: 'invalid markdownlint finding fields' };
    }
    findingFiles.add(fileName);
    rules.add(ruleNames[0]);
  }
  return { findingCount: findings.length, fileCount: findingFiles.size, rules: [...rules].sort() };
}

const explicitBase = process.env.MARKDOWNLINT_BASE_REF;
const explicitHead = process.env.MARKDOWNLINT_HEAD_REF;
let files = [];
if (!lintAllDocs) {
  if (Boolean(explicitBase) !== Boolean(explicitHead)) {
    throw new Error(
      'MARKDOWNLINT_BASE_REF and MARKDOWNLINT_HEAD_REF must be supplied together as one immutable range',
    );
  }
  files = explicitBase ? changedDocs(explicitBase, explicitHead) : changedWorkingTreeDocs();
}

if (!lintAllDocs && files.length === 0) {
  console.log('markdownlint-changed: no changed docs/**/*.md files');
  process.exit(0);
}

const prettierConfig = JSON.parse(readFileSync(resolve(repoRoot, '.prettierrc'), 'utf8'));
if (
  typeof prettierConfig.printWidth !== 'number' ||
  !Number.isSafeInteger(prettierConfig.printWidth) ||
  prettierConfig.printWidth <= 0
) {
  throw new Error('.prettierrc printWidth must be a positive integer');
}

const markdownlintConfigDirectory = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-'));
const markdownlintConfigPath = join(markdownlintConfigDirectory, 'config.json');
const bootstrapOutputPath =
  !lintAllDocs && explicitBase === EMPTY_TREE_OID
    ? join(markdownlintConfigDirectory, 'bootstrap-findings.json')
    : null;
try {
  writeFileSync(
    markdownlintConfigPath,
    `${JSON.stringify({
      MD013: {
        line_length: prettierConfig.printWidth,
        tables: false,
        // A JSON example whose string value is one 250-character sentence cannot
        // be wrapped without becoming invalid JSON, and a shell line cannot be
        // broken without changing what it runs. MD013 measures prose
        // readability; inside a fenced block there is no prose to read and no
        // legal way to comply, which is the same reason `tables` is already off.
        code_blocks: false,
      },
    })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  const localMarkdownlintBin = resolve(repoRoot, 'node_modules/.bin/markdownlint');
  const markdownlintBin = existsSync(localMarkdownlintBin) ? localMarkdownlintBin : 'markdownlint';
  const targets = lintAllDocs ? ['docs/**/*.md'] : files;
  const markdownlintArgs = [
    ...targets,
    '--config',
    markdownlintConfigPath,
    '--ignore',
    'node_modules',
  ];
  if (bootstrapOutputPath) {
    markdownlintArgs.push('--json', '--output', bootstrapOutputPath);
  }
  const result = run(
    markdownlintBin,
    markdownlintArgs,
    // Captured, not inherited: the changed-file lane filters findings to the
    // lines this change actually wrote (see below), so the raw stream would
    // report violations the gate then does not enforce.
    bootstrapOutputPath
      ? { stdio: ['ignore', 'pipe', 'pipe'] }
      : lintAllDocs
        ? { stdio: 'inherit' }
        : {
            stdio: ['ignore', 'inherit', 'pipe'],
            maxBuffer: MARKDOWNLINT_CHANGED_LANE_MAX_BUFFER,
          },
  );
  const changedLaneHandled = !lintAllDocs && !result.error;
  if (changedLaneHandled) {
    if (bootstrapOutputPath) {
      const summary = bootstrapLintSummary(result, bootstrapOutputPath, files);
      if ('reason' in summary) {
        console.error(`markdownlint bootstrap baseline failed: ${summary.reason}`);
        process.exitCode = result.status && result.status > 0 ? result.status : 1;
      } else if (result.status === 0) {
        process.exitCode = 0;
      } else {
        console.log(
          `markdownlint-changed: bootstrap inherited debt: findings=${summary.findingCount} ` +
            `files=${summary.fileCount} rules=${summary.rules.join(',')}; baseline snapshot accepted`,
        );
        process.exitCode = 0;
      }
    } else {
      const filtered = keepFindingsOnChangedLines(
        result.stderr ?? '',
        files,
        explicitBase,
        explicitHead,
      );
      if (filtered.length > 0) {
        console.error(filtered.join('\n'));
      }
      process.exitCode = filtered.length > 0 ? 1 : 0;
      // Debt you did not create is not billed — but it is not hidden either.
      const untouched = (result.stderr ?? '').trim();
      if (untouched && filtered.length === 0) {
        console.log(
          'markdownlint-changed: pre-existing violations in touched files (not billed to this change):\n' +
            untouched,
        );
      }
    }
  } else if (result.error) {
    // "The linter is missing" is not "the docs are bad". spawnSync reports a
    // failure to LAUNCH as status null with `error` set, and collapsing that
    // to a bare exit 1 produced a gate that says a document failed lint
    // without naming a single rule — indistinguishable, to a reader, from
    // real findings. Say which one happened.
    console.error(
      `markdownlint could not be launched (${result.error.code ?? result.error.message}): ` +
        `${markdownlintBin}. Install it (npm i -g markdownlint-cli@0.45.0, as CI does) ` +
        'and re-run — no documents were checked.',
    );
    process.exitCode = 127;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  if (bootstrapOutputPath && existsSync(bootstrapOutputPath)) {
    unlinkSync(bootstrapOutputPath);
  }
  unlinkSync(markdownlintConfigPath);
  rmdirSync(markdownlintConfigDirectory);
}
