#!/usr/bin/env ts-node
/**
 * plan-import-witness: does every module specifier a plan prescribes resolve
 * for its project? (ARIA-HIGH-397)
 * ==========================================================================
 *
 * # Why
 *
 * Convergence measures agreement between two planners. On 2026-10-08 both
 * planners of F-015 agreed on `import type { LeaveRequestStatus } from
 * '@platform/shared-ui/generated/graphql-types'` in hr-module, whose
 * tsconfig maps no `@platform/shared-ui/*` alias. The implementer was the
 * first to run the compiler (TS2307) and refused the plan.
 *
 * # What
 *
 * For each `{specifier, from_path}` the kernel extracted from a plan's key
 * changes (aria_kernel/plan_import_resolution.py), this witness:
 *
 * - finds the project the file belongs to: the nearest `tsconfig.json` from
 *   the file's directory up to the repository root;
 * - parses it with the compiler's own config reader (`extends` included);
 * - asks the compiler's module resolution (`ts.resolveModuleName`) for the
 *   specifier from that file, under that project's options. Files the plan
 *   itself creates are overlaid on the host's file view, so a specifier
 *   that names a planned file resolves.
 *
 * A result is `resolved` only when the compiler resolves it. The TypeScript
 * used is the repository's own (`node_modules/typescript`), and the witness
 * refuses to run against any other copy.
 *
 * # Exit codes
 *
 * - 0: computed (unresolved specifiers are a result, not an error).
 * - 2: environment (unreadable input, a TypeScript that is not the repo's).
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

interface WitnessInput {
  schema_version: number;
  repo_root?: string;
  checks: Array<{ specifier: string; from_path: string }>;
  planned_paths: string[];
}

interface CheckResult {
  specifier: string;
  from_path: string;
  project_config: string | null;
  // The plan itself changes the project's compiler configuration: the
  // answer depends on content the plan has not written yet, so the witness
  // reports it as the plan's to make true and does not judge it.
  config_planned: boolean;
  resolved: boolean;
  resolved_file: string | null;
  reason: string | null;
}

function fail(message: string): never {
  process.stderr.write(`plan-import-witness: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): { input: string } {
  const index = argv.indexOf('--input');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) fail('usage: plan-import-witness.ts --input <file>');
  return { input: value };
}

function loadRepoTypescript(repoRoot: string): typeof import('typescript') {
  // Resolved from the repository root, and refused unless it is the
  // repository's own copy: a global tsc would answer for another compiler.
  const load = createRequire(path.join(repoRoot, 'package.json'));
  let resolved: string;
  try {
    resolved = load.resolve('typescript');
  } catch (error) {
    fail(`typescript_unavailable: ${String(error)}`);
  }
  // Compared as real paths: a checkout's node_modules may be a link to the
  // install it was given, and it is still that checkout's own copy.
  const own = path.join(repoRoot, 'node_modules', 'typescript');
  const pinned = (fs.existsSync(own) ? fs.realpathSync(own) : own) + path.sep;
  if (!fs.realpathSync(resolved).startsWith(pinned)) {
    fail(`typescript_not_repo_pinned: resolved ${resolved}, expected under ${pinned}`);
  }
  return load(resolved) as typeof import('typescript');
}

function nearestConfig(repoRoot: string, fromPath: string): string | null {
  let dir = path.dirname(path.join(repoRoot, fromPath));
  while (dir.startsWith(repoRoot)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === repoRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}

function main(): void {
  const { input } = parseArgs(process.argv.slice(2));
  let parsed: WitnessInput;
  try {
    parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as WitnessInput;
  } catch (error) {
    fail(`input_unreadable: ${String(error)}`);
  }
  if (!Array.isArray(parsed.checks) || !Array.isArray(parsed.planned_paths)) {
    fail('input_malformed: checks and planned_paths must be arrays');
  }
  const repoRoot = path.resolve(parsed.repo_root ?? process.cwd());
  const ts = loadRepoTypescript(repoRoot);
  const planned = new Set(parsed.planned_paths.map((p) => path.join(repoRoot, p)));
  const plannedDirs = new Set<string>();
  for (const file of planned) {
    for (let dir = path.dirname(file); dir.startsWith(repoRoot); dir = path.dirname(dir)) {
      plannedDirs.add(dir);
      if (dir === repoRoot) break;
    }
  }
  // The host is the compiler's own file view with the plan's files overlaid.
  const host: import('typescript').ModuleResolutionHost = {
    fileExists: (file) => planned.has(path.resolve(file)) || ts.sys.fileExists(file),
    readFile: (file) => ts.sys.readFile(file),
    directoryExists: (dir) => plannedDirs.has(path.resolve(dir)) || ts.sys.directoryExists(dir),
    realpath: (file) => (ts.sys.realpath ? ts.sys.realpath(file) : file),
    getCurrentDirectory: () => repoRoot,
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };
  const optionsByConfig = new Map<string, import('typescript').CompilerOptions | string>();
  const results: CheckResult[] = [];
  for (const check of parsed.checks) {
    const config = nearestConfig(repoRoot, check.from_path);
    const configRel = config ? path.relative(repoRoot, config).split(path.sep).join('/') : null;
    if (!config) {
      results.push({
        ...check,
        project_config: null,
        config_planned: false,
        resolved: false,
        resolved_file: null,
        reason: 'no_project_config',
      });
      continue;
    }
    if (planned.has(config)) {
      results.push({
        ...check,
        project_config: configRel,
        config_planned: true,
        resolved: false,
        resolved_file: null,
        reason: 'project_config_planned',
      });
      continue;
    }
    if (!optionsByConfig.has(config)) {
      const read = ts.readConfigFile(config, (file) => ts.sys.readFile(file));
      if (read.error) {
        optionsByConfig.set(
          config,
          `config_unreadable: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
        );
      } else {
        const content = ts.parseJsonConfigFileContent(
          read.config,
          ts.sys,
          path.dirname(config),
          undefined,
          config,
        );
        optionsByConfig.set(config, content.options);
      }
    }
    const options = optionsByConfig.get(config);
    if (typeof options === 'string' || options === undefined) {
      results.push({
        ...check,
        project_config: configRel,
        config_planned: false,
        resolved: false,
        resolved_file: null,
        reason: options ?? 'config_unreadable',
      });
      continue;
    }
    const containing = path.join(repoRoot, check.from_path);
    const answer = ts.resolveModuleName(check.specifier, containing, options, host);
    const file = answer.resolvedModule?.resolvedFileName;
    results.push({
      ...check,
      project_config: configRel,
      config_planned: false,
      resolved: Boolean(file),
      resolved_file: file ? path.relative(repoRoot, file).split(path.sep).join('/') : null,
      reason: file ? null : 'module_not_resolved',
    });
  }
  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      typescript_version: ts.version,
      results,
    }) + '\n',
  );
}

main();
