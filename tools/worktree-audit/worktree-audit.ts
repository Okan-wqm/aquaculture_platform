#!/usr/bin/env ts-node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const GIT_ENV_BLOCKLIST = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
]);

export type Decision =
  | 'ACTIVE'
  | 'PASSIVE_KEEP'
  | 'PASSIVE_REMOVE_AFTER_APPROVAL'
  | 'DETACHED_TEMP'
  | 'DIRTY_NEEDS_OWNER'
  | 'STAGED_NEEDS_COMMIT_DECISION';

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
}

export interface ChangedPath {
  readonly path: string;
  readonly status: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly owner: string;
  readonly matchedPatterns: readonly string[];
}

export interface RoutingRule {
  readonly pattern: string;
  readonly primaryOwner: string;
  readonly alsoNotify: string;
  readonly order: number;
  readonly regex: RegExp;
  readonly specificity: number;
}

export interface PrMetadata {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
  readonly baseRefName?: string;
  readonly title?: string;
  readonly url?: string;
  readonly isDraft?: boolean;
  readonly updatedAt?: string;
  readonly mergedAt?: string | null;
  readonly closedAt?: string | null;
}

interface GitStatus {
  readonly branchHead?: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly files: readonly RawStatusFile[];
}

interface RawStatusFile {
  readonly path: string;
  readonly status: string;
}

interface LastCommit {
  readonly sha: string;
  readonly authoredAt: string;
  readonly author: string;
  readonly subject: string;
}

interface WorktreeRecord {
  readonly auditDate: string;
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly pr: PrMetadata | null;
  readonly lastCommit: LastCommit | null;
  readonly dirty: {
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly total: number;
  };
  readonly files: readonly ChangedPath[];
  readonly owners: Record<string, number>;
  readonly ownershipGaps: readonly string[];
  readonly decision: Decision;
  readonly decisionReasons: readonly string[];
}

interface CliOptions {
  readonly repoRoot: string;
  readonly routingTable: string;
  readonly output?: string;
  readonly report?: string;
  readonly github: boolean;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !GIT_ENV_BLOCKLIST.has(key)),
  );
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryRun(command: string, args: readonly string[], cwd: string): string | null {
  try {
    return run(command, args, cwd);
  } catch {
    return null;
  }
}

export function parseWorktreeList(raw: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; branch?: string; detached?: boolean } = {};

  function flush(): void {
    if (!current.path) {
      current = {};
      return;
    }
    entries.push({
      path: current.path,
      head: current.head,
      branch: current.branch,
      detached: current.detached === true || !current.branch,
    });
    current = {};
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      flush();
      continue;
    }
    const [key, ...valueParts] = line.split(' ');
    const value = valueParts.join(' ');
    if (key === 'worktree') {
      flush();
      current.path = value;
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value;
    } else if (key === 'detached') {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

function parseStatusV2(raw: string): GitStatus {
  let branchHead: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: RawStatusFile[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length);
      branchHead = value === '(detached)' ? undefined : value;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length);
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    const parsed = parseStatusLine(line);
    if (parsed) {
      files.push(parsed);
    }
  }

  return { branchHead, upstream, ahead, behind, files };
}

function parseStatusLine(line: string): RawStatusFile | null {
  if (line.startsWith('? ')) {
    return { status: '??', path: line.slice(2) };
  }
  if (line.startsWith('! ')) {
    return null;
  }
  if (line.startsWith('1 ')) {
    const parts = line.split(' ');
    const status = parts[1];
    const pathWithRename = parts.slice(8).join(' ');
    const path = pathWithRename.split('\t')[0];
    return status && path ? { status, path } : null;
  }
  if (line.startsWith('2 ')) {
    const parts = line.split(' ');
    const status = parts[1];
    const pathWithRename = parts.slice(9).join(' ');
    const path = pathWithRename.split('\t')[0];
    return status && path ? { status, path } : null;
  }
  if (line.startsWith('u ')) {
    const parts = line.split(' ');
    const status = parts[1];
    const path = parts.slice(10).join(' ');
    return status && path ? { status, path } : null;
  }
  return null;
}

function tableCells(line: string): readonly string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function stripMarkdown(value: string): string {
  return value.replace(/`/g, '').replace(/\*/g, '').trim();
}

export function parseRoutingTable(markdown: string): readonly RoutingRule[] {
  const rules: RoutingRule[] = [];
  let order = 0;

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = tableCells(line);
    const filePatternCell = cells[0];
    const primaryOwnerCell = cells[1];
    if (
      cells.length < 3 ||
      filePatternCell === undefined ||
      primaryOwnerCell === undefined ||
      filePatternCell === '---' ||
      filePatternCell === 'File Pattern'
    ) {
      continue;
    }
    const patternMatches = [...filePatternCell.matchAll(/`([^`]+)`/g)];
    if (patternMatches.length === 0) {
      continue;
    }
    const primaryOwner = stripMarkdown(primaryOwnerCell);
    const alsoNotify = stripMarkdown(cells[2] ?? '');
    for (const match of patternMatches) {
      const pattern = match[1];
      if (!pattern) {
        continue;
      }
      rules.push({
        pattern,
        primaryOwner,
        alsoNotify,
        order,
        regex: globToRegex(pattern),
        specificity: pattern.replace(/[\*\?\{\},]/g, '').length,
      });
      order += 1;
    }
  }

  return rules;
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

export function globToRegex(pattern: string): RegExp {
  let source = '^';
  let index = 0;

  while (index < pattern.length) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 2;
      continue;
    }
    const char = pattern[index];
    if (char === undefined) {
      break;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index);
      if (end !== -1) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(',')
          .map((part) => part.split('').map(escapeRegexChar).join(''));
        source += `(?:${alternatives.join('|')})`;
        index = end + 1;
        continue;
      }
    }
    source += escapeRegexChar(char);
    index += 1;
  }

  source += '$';
  return new RegExp(source);
}

export function ownerForPath(path: string, rules: readonly RoutingRule[]): {
  readonly owner: string;
  readonly matchedPatterns: readonly string[];
} {
  const matches = rules.filter((rule) => rule.regex.test(path));
  if (matches.length === 0) {
    return {
      owner: 'PROCESS HIGH ownership gap',
      matchedPatterns: [],
    };
  }
  const sorted = [...matches].sort((left, right) => {
    if (right.specificity !== left.specificity) {
      return right.specificity - left.specificity;
    }
    return left.order - right.order;
  });
  const owner = sorted[0]?.primaryOwner ?? 'PROCESS HIGH ownership gap';
  return {
    owner,
    matchedPatterns: matches.map((rule) => rule.pattern),
  };
}

function classifyChangedPath(file: RawStatusFile, rules: readonly RoutingRule[]): ChangedPath {
  const x = file.status[0] ?? '.';
  const y = file.status[1] ?? '.';
  const untracked = file.status === '??';
  const owner = ownerForPath(file.path, rules);

  return {
    path: file.path,
    status: file.status,
    staged: !untracked && x !== '.',
    unstaged: !untracked && y !== '.',
    untracked,
    owner: owner.owner,
    matchedPatterns: owner.matchedPatterns,
  };
}

function branchShortName(branch?: string, statusBranch?: string): string | null {
  if (statusBranch) {
    return statusBranch;
  }
  if (!branch) {
    return null;
  }
  return branch.replace(/^refs\/heads\//, '');
}

function classifyDecision(entry: WorktreeEntry, status: GitStatus, files: readonly ChangedPath[]): {
  readonly decision: Decision;
  readonly reasons: readonly string[];
} {
  const staged = files.filter((file) => file.staged).length;
  const dirty = files.length;
  const reasons: string[] = [];

  if (staged > 0) {
    reasons.push(`${staged} staged path(s) require explicit commit/drop decision`);
    return { decision: 'STAGED_NEEDS_COMMIT_DECISION', reasons };
  }
  if (dirty > 0) {
    reasons.push(`${dirty} dirty path(s) require owner assignment`);
    return { decision: 'DIRTY_NEEDS_OWNER', reasons };
  }
  if (entry.detached) {
    reasons.push('detached HEAD with clean tree; keep only with salvage/audit evidence');
    return { decision: 'DETACHED_TEMP', reasons };
  }
  if (entry.path.startsWith('/tmp/')) {
    reasons.push('clean worktree outside durable .worktrees location');
    return { decision: 'PASSIVE_REMOVE_AFTER_APPROVAL', reasons };
  }
  if (status.ahead > 0) {
    reasons.push(`branch is ${status.ahead} commit(s) ahead of upstream`);
    return { decision: 'ACTIVE', reasons };
  }
  if (!status.upstream) {
    reasons.push('no upstream recorded');
    return { decision: 'PASSIVE_KEEP', reasons };
  }
  reasons.push('clean durable worktree with upstream');
  return { decision: 'PASSIVE_KEEP', reasons };
}

function lastCommit(path: string): LastCommit | null {
  const raw = tryRun('git', ['-C', path, 'log', '-1', '--format=%H%x09%aI%x09%an%x09%s'], path);
  if (!raw) {
    return null;
  }
  const [sha, authoredAt, author, ...subjectParts] = raw.trimEnd().split('\t');
  if (!sha || !authoredAt || !author) {
    return null;
  }
  return {
    sha,
    authoredAt,
    author,
    subject: subjectParts.join('\t'),
  };
}

function loadPrs(repoRoot: string, includeGithub: boolean): readonly PrMetadata[] {
  if (!includeGithub) {
    return [];
  }
  const remote = tryRun('git', ['remote', 'get-url', 'origin'], repoRoot)?.trim();
  const repoMatch = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  const repo = repoMatch?.[1];
  if (!repo) {
    return [];
  }
  const raw = tryRun(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,state,headRefName,baseRefName,url,title,isDraft,updatedAt,mergedAt,closedAt',
    ],
    repoRoot,
  );
  if (!raw) {
    return [];
  }
  return JSON.parse(raw) as PrMetadata[];
}

function collect(repoRoot: string, routingTable: string, includeGithub: boolean): readonly WorktreeRecord[] {
  const auditDate = new Date().toISOString();
  const worktrees = parseWorktreeList(run('git', ['worktree', 'list', '--porcelain'], repoRoot));
  const rules = parseRoutingTable(readFileSync(routingTable, 'utf8'));
  const prs = loadPrs(repoRoot, includeGithub);
  const prsByHead = new Map(prs.map((pr) => [pr.headRefName, pr]));

  return worktrees.map((entry) => {
    const status = parseStatusV2(
      run('git', ['-C', entry.path, 'status', '--porcelain=v2', '-b', '--untracked-files=all'], repoRoot),
    );
    const branch = branchShortName(entry.branch, status.branchHead);
    const files = status.files.map((file) => classifyChangedPath(file, rules));
    const staged = files.filter((file) => file.staged).length;
    const unstaged = files.filter((file) => file.unstaged).length;
    const untracked = files.filter((file) => file.untracked).length;
    const owners: Record<string, number> = {};
    const ownershipGaps: string[] = [];

    for (const file of files) {
      owners[file.owner] = (owners[file.owner] ?? 0) + 1;
      if (file.owner === 'PROCESS HIGH ownership gap') {
        ownershipGaps.push(file.path);
      }
    }

    const decision = classifyDecision(entry, status, files);

    return {
      auditDate,
      path: entry.path,
      branch,
      head: entry.head ?? null,
      detached: entry.detached,
      upstream: status.upstream ?? null,
      ahead: status.ahead,
      behind: status.behind,
      pr: branch ? prsByHead.get(branch) ?? null : null,
      lastCommit: lastCommit(entry.path),
      dirty: {
        staged,
        unstaged,
        untracked,
        total: files.length,
      },
      files,
      owners,
      ownershipGaps,
      decision: decision.decision,
      decisionReasons: decision.reasons,
    };
  });
}

function renderReport(records: readonly WorktreeRecord[]): string {
  const byDecision = records.reduce<Record<string, number>>((counts, record) => {
    counts[record.decision] = (counts[record.decision] ?? 0) + 1;
    return counts;
  }, {});
  const dirtyRecords = records.filter((record) => record.dirty.total > 0);
  const tempRecords = records.filter((record) => record.path.startsWith('/tmp/'));
  const detachedRecords = records.filter((record) => record.detached);
  const gapRecords = records.filter((record) => record.ownershipGaps.length > 0);

  const lines = [
    '# Aqua-SaaS Worktree Audit Inventory',
    '',
    `Generated: ${records[0]?.auditDate ?? new Date().toISOString()}`,
    '',
    '## Counts',
    '',
    `- Total worktrees: ${records.length}`,
    `- Dirty worktrees: ${dirtyRecords.length}`,
    `- Detached worktrees: ${detachedRecords.length}`,
    `- /tmp worktrees: ${tempRecords.length}`,
    `- Worktrees with ownership gaps: ${gapRecords.length}`,
    '',
    '## Decision Counts',
    '',
    ...Object.entries(byDecision)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([decision, count]) => `- ${decision}: ${count}`),
    '',
    '## Worktrees',
    '',
    '| Path | Branch | Dirty | Ahead/Behind | Decision | Primary Owners |',
    '|---|---|---:|---:|---|---|',
    ...records.map((record) => {
      const owners = Object.entries(record.owners)
        .sort((left, right) => right[1] - left[1])
        .map(([owner, count]) => `${owner} (${count})`)
        .join(', ');
      return [
        record.path,
        record.branch ?? '(detached)',
        `${record.dirty.total} (${record.dirty.staged} staged, ${record.dirty.unstaged} unstaged, ${record.dirty.untracked} untracked)`,
        `${record.ahead}/${record.behind}`,
        record.decision,
        owners || '-',
      ].join(' | ');
    }).map((row) => `| ${row} |`),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let repoRoot = process.cwd();
  let routingTable = '.claude/shared/orchestrator-routing-table.md';
  let output: string | undefined;
  let report: string | undefined;
  let github = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--repo-root' && next) {
      repoRoot = next;
      index += 1;
    } else if (arg === '--routing-table' && next) {
      routingTable = next;
      index += 1;
    } else if (arg === '--output' && next) {
      output = next;
      index += 1;
    } else if (arg === '--report' && next) {
      report = next;
      index += 1;
    } else if (arg === '--github') {
      github = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  const root = resolve(repoRoot);
  return {
    repoRoot: root,
    routingTable: resolve(root, routingTable),
    output: output ? resolve(root, output) : undefined,
    report: report ? resolve(root, report) : undefined,
    github,
  };
}

function printUsage(): void {
  process.stdout.write(`Usage:
  ts-node --project tools/worktree-audit/tsconfig.json tools/worktree-audit/worktree-audit.ts \\
    --repo-root /var/aqua-saas \\
    --output docs/worktrees/YYYY-MM-DD-aqua-saas-worktree-inventory.jsonl \\
    --report /tmp/worktree-audit-summary.md \\
    [--github]

The command is read-only against git worktrees. It writes only the requested output/report files.
`);
}

function main(): void {
  const options = parseArgs(process.argv);
  const records = collect(options.repoRoot, options.routingTable, options.github);
  const jsonl = records.map((record) => JSON.stringify(record)).join('\n');

  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${jsonl}\n`);
  } else {
    process.stdout.write(`${jsonl}\n`);
  }

  if (options.report) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, renderReport(records));
  }
}

if (require.main === module) {
  main();
}
