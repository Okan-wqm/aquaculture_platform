#!/usr/bin/env ts-node
/**
 * Sites setup SSOT guardrails.
 *
 * Default/staged and range modes are intended for CI to block newly-added
 * drift while the existing remediation runs in phases. The all/file modes are
 * useful for auditing the current backlog and are expected to fail until the
 * corresponding plan phase is complete.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

const FARM_SETUP_RUNTIME =
  /^apps\/farm-service\/src\/(site|department|system|equipment|tank|chemical|feed|worker|sentinel-hub|supplier)\/.*\.(ts|tsx)$/;
const FARM_TEST_OR_ENTITY =
  /(__tests__\/|\.spec\.ts$|\.test\.ts$|\/entities\/|\/dto\/|\/commands\/|\/queries\/)/;
const FARM_INFRA = /^apps\/farm-service\/src\/(database|outbox|common\/database)\//;
const GATEWAY_UPLOAD_RUNTIME = /^apps\/gateway-api\/src\/upload\/.*\.(ts|tsx)$/;
const FARM_MODULE_SETUP_FRONTEND =
  /^web\/modules\/farm-module\/src\/(hooks|pages|components)\/.*\.(ts|tsx)$/;

const RULES: readonly Rule[] = [
  {
    id: 'setup-no-direct-eventbus-publish',
    message:
      'Setup business events must use transaction-bound outbox, not direct eventBus.publish.',
    pattern: /\beventBus\s*\.\s*publish\s*\(/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: FARM_TEST_OR_ENTITY,
  },
  {
    id: 'setup-no-nats-eventbus-in-handler',
    message: 'Setup handlers must not inject NatsEventBus directly.',
    pattern: /\bNatsEventBus\b|@Inject\(\s*['"]EVENT_BUS['"]\s*\)/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: FARM_TEST_OR_ENTITY,
  },
  {
    id: 'setup-no-raw-queryrunner',
    message: 'Setup writes must use the tenant transaction helper, not raw createQueryRunner.',
    pattern: /\.\s*createQueryRunner\s*\(/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: new RegExp(`${FARM_TEST_OR_ENTITY.source}|${FARM_INFRA.source}`),
  },
  {
    id: 'setup-no-raw-datasource-transaction',
    message: 'Setup writes must use runInTenantTransaction, not raw dataSource.transaction.',
    pattern: /\bdataSource\s*\.\s*transaction\s*\(/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: FARM_TEST_OR_ENTITY,
  },
  {
    id: 'setup-no-repository-manager-transaction',
    message: 'Setup writes must use runInTenantTransaction, not repository.manager.transaction.',
    pattern: /\b\w+Repository\s*\.\s*manager\s*\.\s*transaction\s*\(/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: FARM_TEST_OR_ENTITY,
  },
  {
    id: 'setup-no-new-raw-repository-injection',
    message:
      'New setup write code must use tenant-scoped repository ports, not raw InjectRepository.',
    pattern: /@InjectRepository\s*\(/,
    includePath: FARM_SETUP_RUNTIME,
    excludePath: FARM_TEST_OR_ENTITY,
  },
  {
    id: 'documents-no-path-presign-contract',
    message:
      'Document presign/delete contracts must resolve by documentId, not caller-supplied path.',
    pattern: /\bpresigned-url\b|@Body\(\)\s*\w+:\s*PresignedUrlDto|\bpath\s*:\s*string\b/,
    includePath: GATEWAY_UPLOAD_RUNTIME,
    excludePath: /(__tests__\/|\.spec\.ts$|\.test\.ts$)/,
  },
  {
    id: 'frontend-no-raw-setup-graphql',
    message:
      'Setup GraphQL operations belong in src/graphql and must be consumed as generated operations.',
    pattern: /\b(query|mutation)\s+[A-Z][A-Za-z0-9_]*\b|gql`/,
    includePath: FARM_MODULE_SETUP_FRONTEND,
    excludePath: /^web\/modules\/farm-module\/src\/graphql\//,
  },
  {
    id: 'frontend-no-unsafe-setup-dto-cast',
    message: 'Setup pages/hooks must map UI drafts to generated input types without unsafe casts.',
    pattern: /\bas\s+(unknown\s+as\s+)?(Create|Update)[A-Za-z0-9_]*Input\b/,
    includePath: FARM_MODULE_SETUP_FRONTEND,
  },
  {
    id: 'frontend-no-browser-alert-confirm',
    message: 'Setup UI must use shared modal/toast flows instead of browser alert/confirm.',
    pattern: /\bwindow\s*\.\s*(alert|confirm)\s*\(|\b(alert|confirm)\s*\(/,
    includePath: FARM_MODULE_SETUP_FRONTEND,
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

function collectAllSetupSurfaces(): readonly AddedLine[] {
  const files = runGit(['ls-files'])
    .split('\n')
    .filter(
      (path) =>
        FARM_SETUP_RUNTIME.test(path) ||
        GATEWAY_UPLOAD_RUNTIME.test(path) ||
        FARM_MODULE_SETUP_FRONTEND.test(path),
    );
  return files.flatMap((path) => collectFile(path));
}

function collectLines(argv: readonly string[]): readonly AddedLine[] {
  const modeEquals = argv.find((arg) => arg.startsWith('--mode='));
  const modeIndex = argv.indexOf('--mode');
  const mode = modeEquals?.slice('--mode='.length) ?? (modeIndex === -1 ? 'staged' : argv[modeIndex + 1]);
  const modeArgIndex = modeEquals ? argv.indexOf(modeEquals) : modeIndex;
  const firstValueIndex = modeEquals ? modeArgIndex + 1 : modeIndex + 2;

  if (mode === 'range') {
    const base = argv[firstValueIndex];
    const head = argv[firstValueIndex + 1];
    if (!base || !head) throw new Error('Usage: --mode range <base> <head>');
    return collectRange(base, head);
  }
  if (mode === 'staged') return collectStaged();
  if (mode === 'file') {
    const path = argv[firstValueIndex];
    if (!path) throw new Error('Usage: --mode file <path>');
    return collectFile(path);
  }
  if (mode === 'all') return collectAllSetupSurfaces();

  throw new Error(`Unknown mode: ${mode ?? ''}`);
}

function findViolations(lines: readonly AddedLine[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const line of lines) {
    for (const rule of RULES) {
      if (!rule.includePath.test(line.path)) continue;
      if (rule.excludePath?.test(line.path)) continue;
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
  throw new Error(`sites setup SSOT guardrail failed:\n${details}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
