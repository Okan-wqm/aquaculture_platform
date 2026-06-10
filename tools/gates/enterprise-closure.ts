#!/usr/bin/env ts-node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.nx',
  '.cache',
  'tmp',
  'target',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.graphql',
  '.hcl',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
}

const HARD_RULES: readonly Rule[] = [
  {
    id: 'no-focused-or-skipped-tests',
    pattern: /\b(?:describe|it|test)\s*\.\s*(?:only|skip)\s*\(/,
    message: 'focused/skipped tests are not accepted in changed or untracked closure surface',
  },
  {
    id: 'no-todo-fixme',
    pattern: /\b(?:TODO|FIXME)\b/i,
    message: 'TODO/FIXME markers are not accepted in closure changes',
  },
  {
    id: 'no-env-bypass',
    pattern: /\b(?:env\s*[-_ ]?bypass|bypass\s*[-_ ]?env|break[-_ ]?glass)\b/i,
    message: 'env bypass or break-glass paths require an architectural replacement before closure',
  },
  {
    id: 'no-quarantine-baseline',
    pattern:
      /(?:--update-baseline|(?:lint-changed-files|type-check-spec)-baseline|quarantine(?:d)?\s+(?:gate|suite|test|spec)|(?:test|spec|gate)\s+quarantine)/i,
    message: 'baseline artifacts or test/gate quarantine mechanisms are not accepted in closure changes',
  },
  {
    id: 'no-typescript-suppression',
    pattern: /^\s*(?:\/\/|\/\*)\s*@ts-(?:ignore|nocheck)\b/,
    message: 'TypeScript suppression comments are not accepted',
  },
  {
    id: 'no-eslint-disable',
    pattern: /^\s*(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/,
    message: 'eslint-disable comments are not accepted',
  },
  {
    id: 'no-istanbul-ignore',
    pattern: /^\s*(?:\/\/|\/\*)\s*istanbul ignore\b/i,
    message: 'coverage ignore comments are not accepted',
  },
];

interface Violation {
  file: string;
  line: number;
  rule: Rule;
  text: string;
}

function run(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });
}

function runInherited(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): void {
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], { cwd: REPO_ROOT, stdio: 'ignore' });
  return result.status === 0;
}

function git(args: readonly string[]): string {
  return run('git', ['-C', REPO_ROOT, ...args]);
}

function lines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function isSkippedPath(file: string): boolean {
  if (file === 'tools/gates/enterprise-closure.ts') return true;
  const parts = file.split(/[\\/]+/);
  return parts.some((part) => SKIP_DIRS.has(part));
}

function isTextFile(file: string): boolean {
  if (isSkippedPath(file)) return false;
  if (!existsSync(resolve(REPO_ROOT, file))) return false;
  const stat = statSync(resolve(REPO_ROOT, file));
  if (!stat.isFile()) return false;
  return TEXT_EXTENSIONS.has(extname(file));
}

function changedAndUntrackedFiles(): string[] {
  return unique([
    ...lines(git(['diff', '--name-only', '--diff-filter=ACMRTUXB', '--'])),
    ...lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB', '--'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ]).filter(isTextFile);
}

function scanHardRules(files: readonly string[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    text.split(/\r?\n/).forEach((lineText, index) => {
      for (const rule of HARD_RULES) {
        if (rule.pattern.test(lineText)) {
          violations.push({ file, line: index + 1, rule, text: lineText.trim() });
        }
      }
    });
  }
  return violations;
}

function assertNoHardRuleViolations(): void {
  const files = changedAndUntrackedFiles();
  const violations = scanHardRules(files);
  if (violations.length === 0) return;

  const rendered = violations
    .slice(0, 200)
    .map(
      (violation) =>
        `- ${violation.file}:${violation.line} [${violation.rule.id}] ${violation.rule.message}\n  ${violation.text}`,
    )
    .join('\n');
  const suffix =
    violations.length > 200 ? `\n... ${violations.length - 200} additional violation(s) omitted` : '';
  throw new Error(`enterprise closure hard-rule scan failed:\n${rendered}${suffix}`);
}

function assertWorktreeClean(): void {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.trim().length === 0) return;
  throw new Error(`enterprise closure requires a clean worktree:\n${status}`);
}

function runtimeDdlSurfaceFiles(): string[] {
  return lines(
    git([
      'ls-files',
      'apps',
      'libs',
      'platform/libs',
      'scripts/deploy',
      'infrastructure/docker/init',
      'infrastructure/docker/init-scripts',
      'docker-compose.droplet.yml',
      'docker-compose.prod.yml',
      'infrastructure/docker/docker-compose.prod.yml',
    ]),
  )
    .filter(isTextFile)
    .filter((file) => extname(file) !== '.md')
    .filter((file) => !file.startsWith('apps/db-migrate/'))
    .filter((file) => !file.startsWith('libs/migration-harness/'))
    .filter((file) => !/\/(__tests__|test|tests|migrations)\//.test(file))
    .filter((file) => !/(\.spec|\.test)\.(ts|tsx|js|jsx)$/.test(file));
}

function removeCodeCommentsPreserveLines(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

function removeOperationalCommentsPreserveLines(text: string): string {
  return removeCodeCommentsPreserveLines(text)
    .replace(/^\s*#.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}

function assertNoAuthoritativeRuntimeDdl(): void {
  const ddlRules: readonly Rule[] = [
    {
      id: 'no-create-database-runtime',
      pattern: /\bCREATE\s+DATABASE\b/i,
      message: 'deploy/runtime surfaces must not create databases; db-migrate or infra bootstrap owns it',
    },
    {
      id: 'no-create-extension-runtime',
      pattern: /\bCREATE\s+EXTENSION\b/i,
      message: 'deploy/runtime surfaces must not create extensions; db-migrate bootstrap owns it',
    },
    {
      id: 'no-create-schema-runtime',
      pattern: /\bCREATE\s+SCHEMA\b/i,
      message: 'runtime services must not create schemas under db-migrate authority',
    },
    {
      id: 'no-create-table-runtime',
      pattern: /\bCREATE\s+TABLE\b/i,
      message: 'runtime services must not create tables under db-migrate authority',
    },
    {
      id: 'no-create-index-runtime',
      pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
      message: 'runtime services must not create indexes under db-migrate authority',
    },
    {
      id: 'no-create-policy-runtime',
      pattern: /\bCREATE\s+POLICY\b/i,
      message: 'runtime services must not create RLS policies under db-migrate authority',
    },
    {
      id: 'no-create-trigger-runtime',
      pattern: /\bCREATE\s+TRIGGER\b/i,
      message: 'runtime services must not create triggers under db-migrate authority',
    },
    {
      id: 'no-force-rls-runtime',
      pattern: /\bALTER\s+TABLE\b[\s\S]{0,120}\b(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i,
      message: 'runtime services must not enable/FORCE RLS; db-migrate owns hardening',
    },
    {
      id: 'no-grant-all-runtime',
      pattern: /\bGRANT\s+ALL\s+PRIVILEGES\b/i,
      message: 'runtime services must not grant broad privileges',
    },
    {
      id: 'no-alter-user-runtime',
      pattern: /\bALTER\s+USER\b/i,
      message: 'deploy/runtime surfaces must not alter database users',
    },
    {
      id: 'no-drop-schema-runtime',
      pattern: /\bDROP\s+SCHEMA\b/i,
      message: 'runtime services must not drop schemas',
    },
    {
      id: 'no-truncate-runtime',
      pattern: /\bTRUNCATE\s+TABLE\b/i,
      message: 'runtime services must not use TRUNCATE; use bounded DML or db-migrate authority',
    },
  ];
  const violations: Violation[] = [];
  for (const file of runtimeDdlSurfaceFiles()) {
    const text = removeOperationalCommentsPreserveLines(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
    text.split(/\r?\n/).forEach((lineText, index) => {
      for (const rule of ddlRules) {
        if (rule.pattern.test(lineText)) {
          violations.push({ file, line: index + 1, rule, text: lineText.trim() });
        }
      }
    });
  }
  if (violations.length === 0) return;
  throw new Error(
    `authoritative runtime DDL gate failed:\n${violations
      .slice(0, 100)
      .map(
        (violation) =>
          `- ${violation.file}:${violation.line} [${violation.rule.id}] ${violation.rule.message}\n  ${violation.text}`,
      )
      .join('\n')}`,
  );
}

function adminConfigRuntimeSurfaceFiles(): string[] {
  return lines(
    git([
      'ls-files',
      'apps/admin-api-service/src/settings',
      'apps/admin-api-service/src/system-management',
      'apps/admin-api-service/src/tenant',
    ]),
  )
    .filter(isTextFile)
    .filter((file) => extname(file) === '.ts')
    .filter((file) => !/\/(__tests__|test|tests|migrations)\//.test(file))
    .filter((file) => !/(\.spec|\.test)\.ts$/.test(file));
}

function assertConfigServiceSsot(): void {
  const configSsotRules: readonly Rule[] = [
    {
      id: 'no-admin-config-entity-runtime',
      pattern:
        /@Entity\(\s*['"](?:tenant_configurations|system_settings|global_configs)['"]/,
      message:
        'admin-api runtime must not expose direct config store entities; config-service is the SSOT',
    },
    {
      id: 'no-admin-config-repository-runtime',
      pattern:
        /(?:@InjectRepository\(\s*(?:TenantConfiguration|SystemSetting|GlobalConfig)\s*\)|Repository<\s*(?:TenantConfiguration|SystemSetting|GlobalConfig)\s*>)/,
      message:
        'admin-api runtime must use config-service adapter/proxy instead of direct config repositories',
    },
    {
      id: 'no-admin-tenant-config-write-runtime',
      pattern: /tenantConfigurationService\s*\.\s*(?:create|update|delete|getOrCreate)?Configuration\s*\(/,
      message:
        'tenant provisioning must request config-service writes instead of admin tenant_configurations writes',
    },
  ];
  const violations: Violation[] = [];
  for (const file of adminConfigRuntimeSurfaceFiles()) {
    const text = removeCodeCommentsPreserveLines(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
    text.split(/\r?\n/).forEach((lineText, index) => {
      for (const rule of configSsotRules) {
        if (rule.pattern.test(lineText)) {
          violations.push({ file, line: index + 1, rule, text: lineText.trim() });
        }
      }
    });
  }
  if (violations.length === 0) return;
  throw new Error(
    `config-service SSOT gate failed:\n${violations
      .slice(0, 100)
      .map(
        (violation) =>
          `- ${violation.file}:${violation.line} [${violation.rule.id}] ${violation.rule.message}\n  ${violation.text}`,
      )
      .join('\n')}`,
  );
}

function farmGateArgs(): string[] {
  const base = process.env.ENTERPRISE_CLOSURE_BASE;
  const head = process.env.ENTERPRISE_CLOSURE_HEAD;
  if (base && head) return ['--', '--mode', 'range', base, head];
  return ['--', '--mode', 'all'];
}

function assertRustEvidence(): void {
  if (!commandExists('cargo')) {
    const sha = process.env.RUST_CI_EVIDENCE_SHA;
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) {
      throw new Error(
        'cargo is not available; provide RUST_CI_EVIDENCE_SHA with a passing Rust CI run/artifact SHA',
      );
    }
    console.log(`cargo not available; accepting Rust CI evidence SHA ${sha}`);
    return;
  }

  runInherited('cargo', ['fmt', '--all', '--check']);
  runInherited('cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
  runInherited('cargo', ['test', '--workspace']);

  if (commandExists('cargo-deny')) {
    runInherited('cargo', ['deny', 'check']);
  } else if (commandExists('cargo-audit')) {
    runInherited('cargo', ['audit']);
  } else if (!process.env.RUST_CI_EVIDENCE_SHA) {
    throw new Error('cargo-deny/cargo-audit is unavailable; provide RUST_CI_EVIDENCE_SHA');
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const skipHeavy = args.includes('--skip-heavy');
  const skipClean = args.includes('--skip-clean');

  assertNoHardRuleViolations();
  assertNoAuthoritativeRuntimeDdl();
  assertConfigServiceSsot();
  if (!skipClean) assertWorktreeClean();
  if (skipHeavy) return;

  runInherited('npm', ['run', 'gates:all']);
  runInherited('npm', ['run', 'gates:farm-service', ...farmGateArgs()]);
  runInherited('npm', ['run', 'gates:sens-enterprise-validation', '--', '--release']);
  runInherited('npm', ['run', 'invariants:fast']);
  runInherited('npm', ['run', 'invariants:full']);
  assertRustEvidence();
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
