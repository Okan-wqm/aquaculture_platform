#!/usr/bin/env ts-node
/**
 * Farm-service enterprise guardrails.
 *
 * Range mode scans added lines only. This lets CI stop new architecture
 * violations while the existing farm-service migration continues under the
 * ADRs and runbooks in docs/architecture and docs/runbooks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface AddedLine {
  path: string;
  lineNumber: number;
  text: string;
}

interface Rule {
  id: string;
  message: string;
  pattern: RegExp;
  includePath: RegExp;
  excludePath?: RegExp;
}

const FARM_CODE = /^apps\/farm-service\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FARM_RUNTIME_CODE = /^apps\/farm-service\/src\/.*\.(ts|tsx)$/;
const FARM_TEST_CODE = /(__tests__\/|\.spec\.ts$|\.test\.ts$|\/test\/)/;
const FARM_INFRA_CODE = /^apps\/farm-service\/src\/(database|outbox|common\/database)\//;
const FARM_READ_PORT_CODE =
  /^apps\/farm-service\/src\/(?:.+\/)?(?:query-handlers|dataloaders)\//;

const RULES: readonly Rule[] = [
  {
    id: 'no-ts-ignore-or-nocheck',
    message: 'Do not add TypeScript suppression comments; fix the type boundary instead.',
    pattern: /@ts-(ignore|nocheck)\b/,
    includePath: FARM_CODE,
  },
  {
    id: 'no-eslint-disable',
    message:
      'Do not add eslint-disable comments in farm-service; move the code behind a governed helper or fix the violation.',
    pattern: /eslint-disable(?:-next-line|-line)?\b/,
    includePath: FARM_CODE,
  },
  {
    id: 'no-istanbul-ignore',
    message: 'Do not add Istanbul ignore comments in farm-service; cover or isolate the branch.',
    pattern: /istanbul ignore\b/,
    includePath: FARM_CODE,
  },
  {
    id: 'no-architecture-suppression',
    message: 'Do not add architecture suppression or unchecked bypass markers in farm-service.',
    pattern:
      /(architecture|architectural|arch)\s*[-_ ]?suppress|suppress\s*[-_ ]?(architecture|architectural|arch)|unchecked\s*[-_ ]?bypass|bypass\s*[-_ ]?unchecked/i,
    includePath: FARM_CODE,
  },
  {
    id: 'no-direct-eventbus-publish',
    message:
      'Farm business events must be written through the transactional outbox, not eventBus.publish in write paths.',
    pattern: /\beventBus\s*\.\s*publish\s*\(/,
    includePath: FARM_RUNTIME_CODE,
    excludePath: new RegExp(`${FARM_INFRA_CODE.source}|${FARM_TEST_CODE.source}`),
  },
  {
    id: 'no-handler-queryrunner',
    message:
      'New farm write paths must use tenant transaction helpers or scoped repository ports, not raw createQueryRunner calls.',
    pattern: /\.\s*createQueryRunner\s*\(/,
    includePath: FARM_RUNTIME_CODE,
    excludePath: new RegExp(
      `${FARM_INFRA_CODE.source}|${FARM_TEST_CODE.source}|${FARM_READ_PORT_CODE.source}`,
    ),
  },
  {
    id: 'no-raw-tenant-header',
    message:
      'Tenant authority must come from verified request context, not raw x-tenant-id header reads.',
    pattern:
      /(@Headers\(\s*["\x27]x-tenant-id["\x27]\s*\)|headers\s*\[\s*["\x27]x-tenant-id["\x27]\s*\])/,
    includePath: FARM_RUNTIME_CODE,
    excludePath: new RegExp(
      `^apps\\/farm-service\\/src\\/(database|outbox|common\\/database|app\\.module\\.ts)|${FARM_TEST_CODE.source}`,
    ),
  },
  {
    id: 'no-new-raw-repository-injection',
    message:
      'New farm application code must use tenant-scoped repository ports instead of raw InjectRepository wiring.',
    pattern: /@InjectRepository\s*\(/,
    includePath: FARM_RUNTIME_CODE,
    excludePath: new RegExp(
      `${FARM_INFRA_CODE.source}|${FARM_TEST_CODE.source}|${FARM_READ_PORT_CODE.source}`,
    ),
  },
];

interface Violation {
  rule: Rule;
  line: AddedLine;
}

function runGit(args: readonly string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseDiff(diff: string): readonly AddedLine[] {
  const added: AddedLine[] = [];
  let currentPath = '';
  let newLineNumber = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      currentPath = rawPath === '/dev/null' ? '' : rawPath.replace(/^b\//, '');
      continue;
    }

    if (line.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLineNumber = match?.[1] ? Number(match[1]) : 0;
      continue;
    }

    if (!currentPath || newLineNumber === 0) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ path: currentPath, lineNumber: newLineNumber, text: line.slice(1) });
      newLineNumber += 1;
      continue;
    }
    if (!line.startsWith('-')) {
      newLineNumber += 1;
    }
  }

  return added;
}

function collectRange(base: string, head: string): readonly AddedLine[] {
  return parseDiff(runGit(['diff', '--unified=0', '--no-ext-diff', base, head, '--']));
}

function collectStaged(): readonly AddedLine[] {
  return parseDiff(runGit(['diff', '--cached', '--unified=0', '--no-ext-diff', '--']));
}

function collectFile(path: string): readonly AddedLine[] {
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) {
    throw new Error(`File does not exist: ${path}`);
  }
  return readFileSync(abs, 'utf8')
    .split('\n')
    .map((text, index) => ({ path: relative(REPO_ROOT, abs), lineNumber: index + 1, text }));
}

function collectAllFarmCode(): readonly AddedLine[] {
  const files = runGit(['ls-files', 'apps/farm-service'])
    .split('\n')
    .filter((path) => FARM_CODE.test(path));
  return files.flatMap((path) => collectFile(path));
}

function collectLines(argv: readonly string[]): readonly AddedLine[] {
  const modeIndex = argv.indexOf('--mode');
  const mode = modeIndex === -1 ? 'staged' : argv[modeIndex + 1];

  if (mode === 'range') {
    const base = argv[modeIndex + 2];
    const head = argv[modeIndex + 3];
    if (!base || !head) throw new Error('Usage: --mode range <base> <head>');
    return collectRange(base, head);
  }
  if (mode === 'staged') return collectStaged();
  if (mode === 'file') {
    const path = argv[modeIndex + 2];
    if (!path) throw new Error('Usage: --mode file <path>');
    return collectFile(path);
  }
  if (mode === 'all') return collectAllFarmCode();

  throw new Error(`Unknown mode: ${mode ?? ''}`);
}

function findViolations(lines: readonly AddedLine[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const line of lines) {
    const trimmed = line.text.trim();
    for (const rule of RULES) {
      if (!rule.includePath.test(line.path)) continue;
      if (rule.excludePath?.test(line.path)) continue;
      if (
        !rule.id.includes('suppression') &&
        !rule.id.startsWith('no-ts-') &&
        !rule.id.startsWith('no-eslint-') &&
        !rule.id.startsWith('no-istanbul-') &&
        (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
      ) {
        continue;
      }
      if (rule.pattern.test(line.text)) {
        violations.push({ rule, line });
      }
    }
  }
  return violations;
}

function main(): void {
  const lines = collectLines(process.argv.slice(2));
  const violations = findViolations(lines);
  if (violations.length === 0) return;

  const details = violations
    .map(
      ({ rule, line }) =>
        `- ${line.path}:${line.lineNumber} [${rule.id}] ${rule.message}\n  ${line.text.trim()}`,
    )
    .join('\n');
  throw new Error(`farm-service enterprise guardrail failed:\n${details}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
