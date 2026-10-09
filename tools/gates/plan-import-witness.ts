#!/usr/bin/env ts-node
/**
 * plan-import-witness: does every module specifier a plan declares resolve
 * for the file that imports it? (ARIA-HIGH-397)
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
 * For each `{specifier, from_path}` a plan's key changes DECLARE (their
 * structured `imports[]`, aria_kernel/plan_import_resolution.py), this
 * witness:
 *
 * - finds the project that compiles the file: the nearest `tsconfig.json`,
 *   or the project it references whose file set holds the file (a Vite-style
 *   solution config); its `extends` chain is read with the compiler's own
 *   config reader;
 * - reports the specifier `config_planned` when the plan itself changes any
 *   config of that chain: the answer then depends on content the plan has
 *   not written, and the implementation's validation judges it;
 * - otherwise asks the compiler's module resolution (`ts.resolveModuleName`)
 *   from that file under that project's options, with the files the plan
 *   creates overlaid on the compiler's file view. A specifier an ambient
 *   `declare module` of the project's own declaration files names (a Module
 *   Federation remote) resolves too.
 *
 * Asset specifiers (a non-code extension, a `?query` suffix) are the
 * bundler's, never the compiler's, and are reported `asset`, not judged.
 * The TypeScript used is the repository's own (`node_modules/typescript`),
 * and the witness refuses to run against any other copy.
 *
 * # Exit codes
 *
 * - 0: computed (unresolved specifiers are a result, not an error).
 * - 2: environment (unreadable input, a TypeScript that is not the repo's).
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type * as TS from 'typescript';

interface WitnessInput {
  schema_version: number;
  repo_root?: string;
  checks: Array<{ specifier: string; from_path: string }>;
  planned_paths: string[];
}

interface CheckResult {
  specifier: string;
  from_path: string;
  // The project that compiles the importing file, and the config of its
  // chain that declares `compilerOptions.paths` (where an alias belongs).
  project_config: string | null;
  paths_config: string | null;
  config_planned: boolean;
  asset: boolean;
  resolved: boolean;
  resolved_file: string | null;
  reason: string | null;
}

interface Project {
  config: string;
  chain: string[];
  options: TS.CompilerOptions;
  fileNames: Set<string>;
  ambient: RegExp[];
  pathsConfig: string;
}

// Extensions the compiler never resolves: the bundler loads them.
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.wav',
  '.html',
  '.md',
  '.txt',
  '.wasm',
]);

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

function loadRepoTypescript(repoRoot: string): typeof TS {
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
  return load(resolved) as typeof TS;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rel(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function isAsset(specifier: string): boolean {
  if (specifier.includes('?')) return true;
  return ASSET_EXTENSIONS.has(path.extname(specifier).toLowerCase());
}

function ambientPattern(name: string): RegExp {
  const escaped = name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

class Projects {
  private readonly cache = new Map<string, Project | string>();

  constructor(
    private readonly ts: typeof TS,
    private readonly repoRoot: string,
  ) {}

  /** The project compiling `file` (absolute), or a reason there is none. */
  forFile(file: string): Project | string {
    let dir = path.dirname(file);
    while (within(this.repoRoot, dir)) {
      const candidate = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(candidate)) {
        const nearest = this.load(candidate);
        if (typeof nearest === 'string') return nearest;
        if (nearest.fileNames.has(file)) return nearest;
        for (const reference of this.references(candidate)) {
          const referenced = this.load(reference);
          if (typeof referenced !== 'string' && referenced.fileNames.has(file)) return referenced;
        }
        return nearest;
      }
      if (dir === this.repoRoot) break;
      dir = path.dirname(dir);
    }
    return 'no_project_config';
  }

  private references(config: string): string[] {
    const read = this.ts.readConfigFile(config, (file) => this.ts.sys.readFile(file));
    const refs =
      (read.config as { references?: Array<{ path?: string }> } | undefined)?.references ?? [];
    return refs
      .map((ref) =>
        typeof ref.path === 'string' ? path.resolve(path.dirname(config), ref.path) : '',
      )
      .filter(Boolean)
      .map((target) => (target.endsWith('.json') ? target : path.join(target, 'tsconfig.json')));
  }

  private chain(config: string): { chain: string[]; pathsConfig: string } {
    const chain: string[] = [];
    let pathsConfig = '';
    const visit = (file: string): void => {
      if (chain.includes(file) || !fs.existsSync(file)) return;
      chain.push(file);
      const read = this.ts.readConfigFile(file, (name) => this.ts.sys.readFile(name));
      const body = read.config as {
        extends?: string | string[];
        compilerOptions?: { paths?: unknown };
      };
      if (!pathsConfig && body?.compilerOptions?.paths) pathsConfig = file;
      const parents = body?.extends === undefined ? [] : ([] as string[]).concat(body.extends);
      for (const parent of parents) {
        const resolved = parent.startsWith('.') ? path.resolve(path.dirname(file), parent) : '';
        if (resolved) visit(resolved.endsWith('.json') ? resolved : `${resolved}.json`);
      }
    };
    visit(config);
    return { chain, pathsConfig: pathsConfig || config };
  }

  private load(config: string): Project | string {
    const cached = this.cache.get(config);
    if (cached !== undefined) return cached;
    const read = this.ts.readConfigFile(config, (file) => this.ts.sys.readFile(file));
    let project: Project | string;
    if (read.error) {
      project = `config_unreadable: ${this.ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`;
    } else {
      const parsed = this.ts.parseJsonConfigFileContent(
        read.config,
        this.ts.sys,
        path.dirname(config),
        undefined,
        config,
      );
      const fileNames = new Set(parsed.fileNames.map((file) => path.resolve(file)));
      const ambient: RegExp[] = [];
      for (const file of fileNames) {
        if (!file.endsWith('.d.ts')) continue;
        const source = this.ts.createSourceFile(
          file,
          this.ts.sys.readFile(file) ?? '',
          this.ts.ScriptTarget.Latest,
        );
        for (const statement of source.statements) {
          if (this.ts.isModuleDeclaration(statement) && this.ts.isStringLiteral(statement.name)) {
            ambient.push(ambientPattern(statement.name.text));
          }
        }
      }
      const { chain, pathsConfig } = this.chain(config);
      project = { config, chain, options: parsed.options, fileNames, ambient, pathsConfig };
    }
    this.cache.set(config, project);
    return project;
  }
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
  // Only files the plan writes are overlaid, never anything under
  // node_modules, and only inside the repository.
  const planned = new Set(
    parsed.planned_paths
      .map((p) => path.resolve(repoRoot, p))
      .filter((file) => within(repoRoot, file) && !file.split(path.sep).includes('node_modules')),
  );
  const plannedDirs = new Set<string>();
  for (const file of planned) {
    for (let dir = path.dirname(file); within(repoRoot, dir); dir = path.dirname(dir)) {
      plannedDirs.add(dir);
      if (dir === repoRoot) break;
    }
  }
  const host: TS.ModuleResolutionHost = {
    fileExists: (file) => planned.has(path.resolve(file)) || ts.sys.fileExists(file),
    readFile: (file) => ts.sys.readFile(file),
    directoryExists: (dir) => plannedDirs.has(path.resolve(dir)) || ts.sys.directoryExists(dir),
    realpath: (file) => (ts.sys.realpath ? ts.sys.realpath(file) : file),
    getCurrentDirectory: () => repoRoot,
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };
  const projects = new Projects(ts, repoRoot);
  const results: CheckResult[] = [];
  for (const check of parsed.checks) {
    const base = {
      ...check,
      project_config: null,
      paths_config: null,
      config_planned: false,
      asset: false,
    };
    if (isAsset(check.specifier)) {
      results.push({
        ...base,
        asset: true,
        resolved: true,
        resolved_file: null,
        reason: 'asset_specifier',
      });
      continue;
    }
    const containing = path.resolve(repoRoot, check.from_path);
    const project = projects.forFile(containing);
    if (typeof project === 'string') {
      results.push({ ...base, resolved: false, resolved_file: null, reason: project });
      continue;
    }
    const facts = {
      ...base,
      project_config: rel(repoRoot, project.config),
      paths_config: rel(repoRoot, project.pathsConfig),
    };
    if (project.chain.some((config) => planned.has(config))) {
      results.push({
        ...facts,
        config_planned: true,
        resolved: false,
        resolved_file: null,
        reason: 'project_config_planned',
      });
      continue;
    }
    const answer = ts.resolveModuleName(check.specifier, containing, project.options, host);
    const file = answer.resolvedModule?.resolvedFileName;
    if (file) {
      results.push({ ...facts, resolved: true, resolved_file: rel(repoRoot, file), reason: null });
    } else if (project.ambient.some((pattern) => pattern.test(check.specifier))) {
      results.push({
        ...facts,
        resolved: true,
        resolved_file: null,
        reason: 'ambient_module_declaration',
      });
    } else {
      results.push({
        ...facts,
        resolved: false,
        resolved_file: null,
        reason: 'module_not_resolved',
      });
    }
  }
  process.stdout.write(
    JSON.stringify({ schema_version: 2, typescript_version: ts.version, results }) + '\n',
  );
}

main();
