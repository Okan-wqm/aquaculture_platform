#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.NX_DAEMON = 'false';
process.env.NX_INTERACTIVE = 'false';
process.env.NX_ISOLATE_PLUGINS = 'false';
process.env.NX_TASKS_RUNNER_DYNAMIC_OUTPUT = 'false';
process.env.CI = 'true';
const QUALITY_ROOT = join(REPO_ROOT, 'tools', 'quality');
const FORMAT_SCOPE = join(QUALITY_ROOT, 'format-scope.json');
const LINT_INVENTORY = join(QUALITY_ROOT, 'lint-target-inventory.json');
const RUST_MANIFEST = join(QUALITY_ROOT, 'rust-toolchain-manifest.json');
const CLOSURE_MANIFEST = join(QUALITY_ROOT, 'closure-manifest.json');
const EVIDENCE_ROOT = join(REPO_ROOT, '.aria-ci', 'terminal-evidence');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
// Adaptation to current main (cluster-10 port): `gates:all` is already
// owned by the chained npm gate runner in package.json — this tooling
// must not contest that name. The closure runner lives under its own
// `quality:closure-run` entrypoint instead.
const EXPECTED_CLOSURE_ENTRYPOINTS = Object.freeze({
  'quality:closure-run': 'node tools/quality/quality.mjs closure-run --profile gates-all',
  'gates:enterprise-closure':
    'ts-node --project tools/gates/tsconfig.runtime.json tools/gates/enterprise-closure.ts',
});

const FORMAT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md']);
const NODE_COMPONENTS_LINT_SHARDS = [
  ['src/config/**/*.ts', 'src/registry/**/*.ts', 'src/wrappers/**/*.tsx', 'vite.config.ts'],
  ['src/edges/**/*.tsx'],
  ['src/nodes/AlgaeBagNode.tsx', 'src/nodes/AutomaticFeederNode.tsx', 'src/nodes/BaseNode.tsx'],
  [
    'src/nodes/BlowerNode.tsx',
    'src/nodes/ChillerNode.tsx',
    'src/nodes/CleanWaterTankNode.tsx',
    'src/nodes/ConnectionPointNode.tsx',
  ],
  [
    'src/nodes/DemandFeederNode.tsx',
    'src/nodes/DieselGeneratorNode.tsx',
    'src/nodes/DirtyWaterTankNode.tsx',
    'src/nodes/DosingPumpNode.tsx',
  ],
  [
    'src/nodes/DrumFilterNode.tsx',
    'src/nodes/DualDrainTankNode.tsx',
    'src/nodes/EquipmentNode.tsx',
    'src/nodes/FishTankNode.tsx',
  ],
  [
    'src/nodes/GasGeneratorNode.tsx',
    'src/nodes/HEPAFilterNode.tsx',
    'src/nodes/HeaterNode.tsx',
    'src/nodes/MBBRNode.tsx',
  ],
  [
    'src/nodes/OxygenGeneratorNode.tsx',
    'src/nodes/OzoneGeneratorNode.tsx',
    'src/nodes/PlateHeatExchangerNode.tsx',
    'src/nodes/PumpNode.tsx',
  ],
  [
    'src/nodes/RadialSettlerNode.tsx',
    'src/nodes/SensorNode.tsx',
    'src/nodes/ShellTubeHeatExchangerNode.tsx',
    'src/nodes/TankInletNode.tsx',
  ],
  [
    'src/nodes/UVUnitNode.tsx',
    'src/nodes/UltrafiltrationNode.tsx',
    'src/nodes/ValveNode.tsx',
    'src/nodes/WaterDischargeNode.tsx',
    'src/nodes/WaterSupplyNode.tsx',
    'src/nodes/index.ts',
  ],
];
const DEFAULT_ENV_ALLOWLIST = [
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_JOB',
  'GITHUB_WORKFLOW',
  'GITHUB_SHA',
  'RUNNER_NAME',
  'RUNNER_OS',
  'NODE_OPTIONS',
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PYTHONPATH',
  'PYTHONDONTWRITEBYTECODE',
];
const CLOSURE_ENVIRONMENT = Object.freeze({
  CI: 'true',
  NX_DAEMON: 'false',
  NX_INTERACTIVE: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_TASKS_RUNNER_DYNAMIC_OUTPUT: 'false',
});

function usage() {
  throw new Error(
    [
      'usage: node tools/quality/quality.mjs <command>',
      'commands:',
      '  format-scope generate|check',
      '  format check|check-changed|check-staged|write|write-changed',
      '  lint-inventory generate|check',
      '  lint-all [--max-warnings=0]',
      '  rust-toolchain generate|check',
      '  closure-manifest generate|check',
      '  inventory generate|check',
      '  closure-run --profile <gates-all|enterprise-closure>',
    ].join('\n'),
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
  return result;
}

function runRequired(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status ?? result.signal}`,
    );
  }
  return result.stdout ?? '';
}

function stable(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function writeStableJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(stable(value), null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileSha(path) {
  return sha256(readFileSync(join(REPO_ROOT, path)));
}

function gitLsFiles() {
  // TRACKED FILES ONLY — see the source note at the manifest builder. The
  // untracked inclusion is what made the committed manifest carry foreign WIP
  // that CI's clean checkout has never contained.
  const out = runRequired('git', ['ls-files', '--cached', '-z']);
  return out.split('\0').filter(Boolean).sort();
}

function extensionOf(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index);
}

function classifyFormatFile(path) {
  if (!FORMAT_EXTENSIONS.has(extensionOf(path))) return null;
  if (path === 'package-lock.json' || path.endsWith('/package-lock.json')) {
    return excluded(
      path,
      'generated',
      'node-package-lock',
      'lockfile is governed by npm ci and dependency policy',
    );
  }
  if (path.includes('/node_modules/') || path.startsWith('node_modules/')) {
    return excluded(path, 'vendor_or_external', 'dependency-vendor', 'third-party dependency tree');
  }
  if (path.startsWith('.codex-worktrees/') || path.startsWith('.worktrees/')) {
    return excluded(
      path,
      'runtime_evidence',
      'agent-worktree',
      'nested worktree content is not repo authority',
    );
  }
  if (path.startsWith('agent-workspace/')) {
    return excluded(path, 'runtime_evidence', 'agent-workspace', 'agent runtime workspace output');
  }
  if (path.startsWith('docs/superpowers/inventories/')) {
    return excluded(
      path,
      'runtime_evidence',
      'agent-inventory-evidence',
      'serialized agent inventory transcript; content is hash-pinned evidence',
    );
  }
  const newAriaPlan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering/';
  if (
    path.startsWith(`${newAriaPlan}reviews/`) ||
    path.startsWith(`${newAriaPlan}progress/evidence/`)
  ) {
    return excluded(
      path,
      'archive_immutable',
      'new-aria-evidence-authority',
      'append-only historical evidence is hash-pinned and must retain its original bytes',
    );
  }
  if (path.includes('/.archive/') || path.includes('/archive/')) {
    return excluded(
      path,
      'archive_immutable',
      'archive-owner',
      'historical archive content is hash-pinned evidence',
    );
  }
  if (path.includes('/generated/') || path.includes('.generated.')) {
    return excluded(
      path,
      'generated',
      'codegen-owner',
      'generated artifact; source generator is canonical',
    );
  }
  if (
    path.includes('/public/libs/') &&
    (path.endsWith('.umd.js') || path.endsWith('.bundle.js') || path.endsWith('.min.js'))
  ) {
    return excluded(
      path,
      'generated',
      'frontend-bundle-owner',
      'checked-in browser bundle; generator/source package is canonical',
    );
  }
  if (path.startsWith('.aria-ci/') || path.startsWith('aria-tools/')) {
    return excluded(
      path,
      'runtime_evidence',
      'aria-runtime',
      'runtime evidence is declared artifact output',
    );
  }
  if (path.startsWith('.claude/')) {
    return managed(path, 'agent_contract_docs', 'agent-governance');
  }
  if (path.startsWith('docs/')) {
    return managed(path, 'canonical_docs', 'docs');
  }
  return managed(path, 'canonical_source', 'source');
}

function managed(path, cls, owner) {
  return {
    path,
    class: cls,
    prettier_managed: true,
    owner,
  };
}

function excluded(path, cls, owner, reason) {
  return {
    path,
    class: cls,
    prettier_managed: false,
    owner,
    reason,
    source_of_truth: cls === 'generated' ? 'generator' : 'committed_hash',
    hash_policy: 'sha256',
    content_sha256: existsSync(join(REPO_ROOT, path)) ? fileSha(path) : null,
    review_required: true,
  };
}

function buildFormatScope() {
  const entries = gitLsFiles()
    .map(classifyFormatFile)
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
  // NO DERIVED SUMMARY SCALARS HERE, DELIBERATELY.
  //
  // This manifest used to also carry `file_count`, `managed_count` and
  // `managed_file_list_sha256`. All three were pure functions of `entries`,
  // sitting in the same file as `entries`, and — measured — they had exactly
  // one producer (this function) and ZERO readers: `getManagedFormatFiles`,
  // the only consumer of the manifest, reads `.entries` alone.
  //
  // Their cost was not neutral. Any branch that adds or removes a single
  // tracked file changes all three, so two branches conflict on those same
  // lines REGARDLESS of which files each one touched. That made a merge
  // conflict here structurally certain rather than occasional: five in one
  // day once two sessions were working at once, each resolved identically
  // and carrying no information, because `checkManifest` rebuilds the
  // manifest from the tree and refuses anything that differs — so whichever
  // side of the conflict is taken, the content is recomputed anyway.
  //
  // Removing them costs no detection power: `checkManifest` still compares
  // all ~9,300 entries byte-for-byte, and a checksum of data present in the
  // same file never added any. `format-scope-derived-scalars.spec.ts` keeps
  // them from coming back.
  return {
    schema_version: 1,
    generated_by: 'tools/quality/quality.mjs format-scope generate',
    // TRACKED FILES ONLY. The manifest is a committed artifact, so its scope
    // must be exactly what a clean CI checkout contains. Including untracked
    // files (--others) made every generate run on a working tree carrying
    // foreign WIP commit entries for files CI has never seen — the check then
    // fails on the merge ref while passing locally, a treadmill PR #1300
    // measured three times in one day. A committer stages a new file, then
    // regenerates; the staged-but-uncommitted file is in --cached already.
    source: 'git ls-files --cached',
    entries,
  };
}

function checkManifest(path, build) {
  const expected = stable(build());
  if (!existsSync(path)) {
    fail(`${relative(REPO_ROOT, path)} is missing; run the matching generate command`);
  }
  const actual = stable(readJson(path));
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  const actualText = `${JSON.stringify(actual, null, 2)}\n`;
  if (expectedText !== actualText) {
    fail(`${relative(REPO_ROOT, path)} is stale; regenerate it`);
  }
  process.stdout.write(`${relative(REPO_ROOT, path)}: ok\n`);
}

function validateClosureEntrypoints() {
  const pkg = readJson(PACKAGE_JSON);
  for (const [name, expected] of Object.entries(EXPECTED_CLOSURE_ENTRYPOINTS)) {
    const actual = pkg.scripts?.[name];
    if (actual !== expected) {
      fail(`package.json script ${name} must be exactly: ${expected}`);
    }
  }
}

function writeClosureManifest() {
  validateClosureEntrypoints();
  writeStableJson(CLOSURE_MANIFEST, buildClosureManifest());
}

function checkClosureManifest() {
  validateClosureEntrypoints();
  checkManifest(CLOSURE_MANIFEST, buildClosureManifest);
}

function getManagedFormatFiles() {
  if (!existsSync(FORMAT_SCOPE))
    fail('format scope missing; run npm run quality:format-scope:generate');
  return readJson(FORMAT_SCOPE)
    .entries.filter((entry) => entry.prettier_managed)
    .map((entry) => entry.path);
}

function runPrettier(mode) {
  checkManifest(FORMAT_SCOPE, buildFormatScope);
  const files = getManagedFormatFiles();
  runPrettierFiles(mode, files);
}

function prettierBin() {
  return join(
    REPO_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
  );
}

function runPrettierFiles(mode, files) {
  const bin = prettierBin();
  const action = mode === 'write' ? '--write' : '--check';
  const batchSize = 120;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const result = run(bin, [action, '--ignore-unknown', ...batch], { stdio: 'inherit' });
    if (result.status !== 0) {
      process.stderr.write(
        [
          `[format] prettier ${mode} failed for batch ${Math.floor(i / batchSize) + 1}`,
          `files: ${batch[0]} ... ${batch[batch.length - 1]}`,
        ].join('\n') + '\n',
      );
      process.exit(result.status ?? 1);
    }
  }
}

/**
 * The regression rule, defined exactly once.
 *
 * A file fails only when it is drifted NOW **and** was Prettier-clean at the
 * comparison point. A file already drifted at that point is pre-existing debt
 * the gate deliberately tolerates, so an unrelated change is never forced to
 * carry a formatting cleanup it did not cause.
 *
 * WHY the two readers are injected: the identical rule has to serve a worktree
 * comparison (`check-changed`, what CI runs against the PR base) and an index
 * comparison (`check-staged`, what the pre-commit hook runs against HEAD). The
 * alternative was a second copy of the rule for the hook — and two copies of
 * one gate drifting apart is precisely the defect this function exists to stop
 * (ORPHAN-HIGH-500).
 */
function classifyFormatDrift(files, readCurrent, readBase) {
  const bin = prettierBin();
  const regressions = [];
  const legacyDebt = [];

  for (const path of files) {
    const currentSource = readCurrent(path);
    if (currentSource === null) continue;
    if (isPrettierCleanSource(bin, path, currentSource)) continue;

    const baseSource = readBase(path);
    // No blob at the comparison point means the file is new here, so its drift
    // cannot be inherited — it is a regression.
    if (baseSource === null || isPrettierCleanSource(bin, path, baseSource)) {
      regressions.push(path);
    } else {
      legacyDebt.push(path);
    }
  }

  return { regressions, legacyDebt };
}

function reportFormatDrift(label, checked, regressions, legacyDebt, { fix }) {
  for (const path of legacyDebt) {
    process.stdout.write(`[format] existing debt retained from base: ${path}\n`);
  }
  if (regressions.length > 0) {
    process.stderr.write(
      `[format] changed file(s) introduced Prettier drift:\n${regressions
        .map((path) => `  ${path}`)
        .join('\n')}\n${fix}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `${label}: ${checked} managed file(s) checked; ${legacyDebt.length} base-debt file(s) quarantined\n`,
  );
}

function resolveFormatBase() {
  const candidate = process.env.FORMAT_BASE_SHA?.trim() ?? '';
  if (candidate && !/^0+$/.test(candidate)) {
    if (!/^[0-9a-f]{40}$/i.test(candidate)) {
      fail('format check-changed: FORMAT_BASE_SHA must be a full commit SHA');
    }
    runRequired('git', ['cat-file', '-e', `${candidate}^{commit}`]);
    return candidate;
  }
  return runRequired('git', ['rev-parse', '--verify', 'HEAD^']).trim();
}

/** Managed files changed in the worktree since `base`. */
function changedManagedFiles(base) {
  const changed = runRequired('git', [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACMR',
    base,
    '--',
  ])
    .split('\0')
    .filter(Boolean);
  const managed = new Set(getManagedFormatFiles());
  return changed.filter((path) => managed.has(path) && existsSync(join(REPO_ROOT, path)));
}

function worktreeReaders(base) {
  return [
    (path) => readFileSync(join(REPO_ROOT, path), 'utf8'),
    (path) => {
      const blob = run('git', ['show', `${base}:${path}`]);
      return blob.status === 0 ? (blob.stdout ?? '') : null;
    },
  ];
}

function runPrettierChanged() {
  checkManifest(FORMAT_SCOPE, buildFormatScope);
  const base = resolveFormatBase();
  const files = changedManagedFiles(base);

  if (files.length === 0) {
    process.stdout.write(`format check-changed: no managed files changed since ${base}\n`);
    return;
  }

  const [readCurrent, readBase] = worktreeReaders(base);
  const { regressions, legacyDebt } = classifyFormatDrift(files, readCurrent, readBase);
  reportFormatDrift('format check-changed', files.length, regressions, legacyDebt, {
    fix: '[format] fix with: node tools/quality/quality.mjs format write-changed',
  });
}

/**
 * The scoped counterpart to `check-changed`: rewrite exactly the regression set.
 *
 * WHY this mode exists: without it the only one-command fix is repo-wide
 * `format write`, which also rewrites every quarantined base-debt file and
 * buries a small fix in unrelated churn. Making the correct scoped fix the
 * zero-effort default is the whole point (ORPHAN-HIGH-500).
 */
function runPrettierWriteChanged() {
  checkManifest(FORMAT_SCOPE, buildFormatScope);
  const base = resolveFormatBase();
  const files = changedManagedFiles(base);

  if (files.length === 0) {
    process.stdout.write(`format write-changed: no managed files changed since ${base}\n`);
    return;
  }

  const [readCurrent, readBase] = worktreeReaders(base);
  const { regressions, legacyDebt } = classifyFormatDrift(files, readCurrent, readBase);

  if (regressions.length === 0) {
    process.stdout.write(
      `format write-changed: nothing to rewrite; ${legacyDebt.length} base-debt file(s) left untouched\n`,
    );
    return;
  }

  // Prettier's markdown printer is not always a fixed point in ONE pass: a
  // single --write can leave a file that --check still rejects, converging only
  // on the next pass. Observed on
  // docs/reviews/2026-07-26-aria-codex-audit-verification.md while closing
  // ORPHAN-HIGH-500. If this mode wrote once and returned, it would hand the
  // developer a green command and a red CI — the exact failure it exists to
  // prevent — so it iterates to a fixed point and refuses to claim success
  // without reaching one.
  const MAX_PASSES = 3;
  let pending = regressions;
  let passes = 0;

  while (pending.length > 0 && passes < MAX_PASSES) {
    runPrettierFiles('write', pending);
    passes += 1;
    pending = classifyFormatDrift(pending, readCurrent, readBase).regressions;
  }

  if (pending.length > 0) {
    fail(
      [
        `format write-changed: ${pending.length} file(s) still drifted after ${MAX_PASSES} passes:`,
        ...pending.map((path) => `  ${path}`),
        'Prettier is not converging on these files; fix them by hand.',
      ].join('\n'),
    );
  }

  process.stdout.write(
    `format write-changed: rewrote ${regressions.length} file(s) in ${passes} pass(es); ` +
      `${legacyDebt.length} base-debt file(s) left untouched\n`,
  );
}

/**
 * The pre-commit counterpart: judge the STAGED bytes against HEAD.
 *
 * WHY staged rather than the `HEAD^` fallback `check-changed` uses: at
 * pre-commit time the content under test is in the index and not yet
 * committed, so `HEAD^` compares the wrong pair. The right question is "is this
 * file drifted as staged, when it was clean at HEAD?" — which is CI's own rule
 * with base=HEAD, and it fires on the commit that introduces the drift instead
 * of on the push that turns CI red.
 */
function runPrettierCheckStaged() {
  checkManifest(FORMAT_SCOPE, buildFormatScope);

  const staged = runRequired('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
  const managed = new Set(getManagedFormatFiles());
  const files = staged.filter((path) => managed.has(path));

  if (files.length === 0) {
    process.stdout.write('format check-staged: no managed files staged\n');
    return;
  }

  // A repository without HEAD (first commit) has no comparison point, so every
  // drift is a regression — fail closed rather than silently passing.
  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD']).status === 0;

  const { regressions, legacyDebt } = classifyFormatDrift(
    files,
    (path) => {
      const blob = run('git', ['show', `:${path}`]);
      return blob.status === 0 ? (blob.stdout ?? '') : null;
    },
    (path) => {
      if (!hasHead) return null;
      const blob = run('git', ['show', `HEAD:${path}`]);
      return blob.status === 0 ? (blob.stdout ?? '') : null;
    },
  );

  reportFormatDrift('format check-staged', files.length, regressions, legacyDebt, {
    fix: '[format] fix with: node tools/quality/quality.mjs format write-changed && git add -u',
  });
}

function isPrettierCleanSource(bin, path, source) {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'aqua-format-check-'));
  const scratchPath = join(scratchRoot, basename(path));
  writeFileSync(scratchPath, source, 'utf8');

  try {
    const result = run(
      bin,
      [
        '--check',
        '--config',
        join(REPO_ROOT, '.prettierrc'),
        '--ignore-path',
        join(REPO_ROOT, '.prettierignore'),
        scratchPath,
      ],
      { cwd: REPO_ROOT },
    );
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`prettier could not parse ${path}`);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function nxProject(name) {
  return JSON.parse(runRequired('npx', ['nx', 'show', 'project', name, '--json']));
}

function classifyLintTarget(project) {
  const root = project.root ?? '';
  const target = project.targets?.lint ?? {};
  const executor = target.executor ?? '';
  if (executor === '@aqua/cargo:run' || root.startsWith('crates/')) return 'rust-clippy';
  if (project.name === 'node-red-project' || root.includes('simulators/nodered'))
    return 'js-node-commonjs';
  if (project.name === '@aquaculture/node-components' || root === 'libs/node-components')
    return 'eslint-ts-sharded';
  if (root === 'e2e' || root.startsWith('e2e/')) return 'eslint-ts-heavy';
  if (root.startsWith('web/')) return 'eslint-web-heavy';
  return 'eslint-ts';
}

function buildLintInventory() {
  const names = JSON.parse(
    runRequired('npx', ['nx', 'show', 'projects', '--withTarget', 'lint', '--json']),
  );
  const entries = names.sort().map((name) => {
    const project = nxProject(name);
    const target = project.targets?.lint ?? {};
    const resource_class = classifyLintTarget(project);
    const entry = {
      name,
      root: project.root ?? '',
      executor: target.executor ?? null,
      command: target.options?.command ?? null,
      cwd: target.options?.cwd ?? null,
      resource_class,
      max_warnings: 0,
      runner: 'nx',
      args: ['nx', 'run', `${name}:lint`, '--skip-nx-cache', '--', '--max-warnings=0'],
    };
    if (resource_class === 'eslint-ts-sharded') {
      return {
        ...entry,
        runner: 'eslint-shards',
        args: ['eslint', '<shard>', '--max-warnings=0'],
        shards: NODE_COMPONENTS_LINT_SHARDS,
      };
    }
    return entry;
  });
  return {
    schema_version: 1,
    generated_by: 'tools/quality/quality.mjs lint-inventory generate',
    source: 'nx project graph',
    target_count: entries.length,
    target_list_sha256: sha256(
      entries.map((entry) => `${entry.name}:${entry.resource_class}`).join('\n'),
    ),
    entries,
  };
}

function runLintAll() {
  checkManifest(LINT_INVENTORY, buildLintInventory);
  const inventory = readJson(LINT_INVENTORY);
  for (const entry of inventory.entries) {
    if (entry.resource_class === 'rust-clippy') {
      checkRustToolchain();
    }
    const env = { ...process.env };
    env.NX_DAEMON = 'false';
    env.NX_ISOLATE_PLUGINS = 'false';
    if (entry.resource_class.startsWith('eslint-')) {
      env.NODE_OPTIONS = process.env.NODE_OPTIONS ?? '--max-old-space-size=4096';
    }
    process.stdout.write(`[lint-all] ${entry.name} (${entry.resource_class})\n`);
    if (entry.runner === 'eslint-shards') {
      for (let index = 0; index < entry.shards.length; index += 1) {
        const shard = entry.shards[index];
        process.stdout.write(
          `[lint-all] ${entry.name} shard ${index + 1}/${entry.shards.length}\n`,
        );
        const shardResult = run('npx', ['eslint', ...shard, '--max-warnings=0'], {
          cwd: join(REPO_ROOT, entry.cwd ?? entry.root),
          stdio: 'inherit',
          env,
        });
        if (shardResult.status !== 0) {
          if (shardResult.signal === 'SIGKILL' || shardResult.status === 137) {
            fail(
              `[lint-all] ${entry.name} shard ${index + 1} failed with OOM/137; split the shard before retrying`,
            );
          }
          process.exit(shardResult.status ?? 1);
        }
      }
      continue;
    }
    const result = run('npx', entry.args, { stdio: 'inherit', env });
    if (result.status !== 0) {
      if (result.signal === 'SIGKILL' || result.status === 137) {
        fail(
          `[lint-all] ${entry.name} failed with OOM/137; update resource class instead of retrying`,
        );
      }
      process.exit(result.status ?? 1);
    }
  }
}

function parseRustToolchainToml() {
  const raw = readFileSync(join(REPO_ROOT, 'rust-toolchain.toml'), 'utf8');
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? '';
  const components = parseTomlArray(raw, 'components');
  const targets = parseTomlArray(raw, 'targets');
  return { channel, components, targets };
}

function parseTomlArray(raw, key) {
  const hit = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(raw);
  if (!hit) return [];
  return hit[1]
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .sort();
}

function cargoWorkspaceMembers() {
  const raw = readFileSync(join(REPO_ROOT, 'Cargo.toml'), 'utf8');
  const hit = /members\s*=\s*\[([\s\S]*?)\]/m.exec(raw);
  if (!hit) return [];
  return hit[1]
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim().replace(/,$/, '').replace(/^"|"$/g, ''))
    .filter(Boolean)
    .sort();
}

function buildRustManifest() {
  const toolchain = parseRustToolchainToml();
  const lockPath = join(REPO_ROOT, 'Cargo.lock');
  return {
    schema_version: 1,
    generated_by: 'tools/quality/quality.mjs rust-toolchain generate',
    authority: 'rust-toolchain.toml',
    channel: toolchain.channel,
    components: toolchain.components,
    targets: toolchain.targets,
    cargo_lock_sha256: existsSync(lockPath) ? sha256(readFileSync(lockPath)) : null,
    workspace_members: cargoWorkspaceMembers(),
  };
}

function checkCommandExists(command) {
  const result = run(resolveToolCommand(command), ['--version']);
  if (result.status !== 0) {
    throw new Error(`TOOLCHAIN_MISSING: ${command} is required by rust-toolchain.toml`);
  }
  return (result.stdout ?? result.stderr ?? '').trim();
}

function resolveToolCommand(command) {
  const cargoHomeBin = process.env.HOME ? join(process.env.HOME, '.cargo', 'bin') : null;
  if (cargoHomeBin) {
    const rustupCandidate = join(cargoHomeBin, command);
    if (existsSync(rustupCandidate)) return rustupCandidate;
  }
  return command;
}

function checkRustToolchain() {
  checkManifest(RUST_MANIFEST, buildRustManifest);
  const manifest = readJson(RUST_MANIFEST);
  const rustcVersion = checkCommandExists('rustc');
  const cargoVersion = checkCommandExists('cargo');
  if (!rustcVersion.includes(` ${manifest.channel}`)) {
    throw new Error(`TOOLCHAIN_MISMATCH: expected rustc ${manifest.channel}, got ${rustcVersion}`);
  }
  if (!cargoVersion.includes(` ${manifest.channel}`)) {
    throw new Error(`TOOLCHAIN_MISMATCH: expected cargo ${manifest.channel}, got ${cargoVersion}`);
  }
  const rustup = resolveToolCommand('rustup');
  const components = runRequired(rustup, ['component', 'list', '--installed']).split('\n');
  for (const component of manifest.components) {
    if (!components.some((line) => line.startsWith(component))) {
      throw new Error(`TOOLCHAIN_MISSING: rustup component ${component}`);
    }
  }
  const targets = runRequired(rustup, ['target', 'list', '--installed'])
    .split('\n')
    .map((line) => line.trim());
  for (const target of manifest.targets) {
    if (!targets.includes(target)) {
      throw new Error(`TOOLCHAIN_MISSING: rustup target ${target}`);
    }
  }
  process.stdout.write('rust toolchain: ok\n');
}

function buildClosureManifest() {
  const gatesAll = [
    step('quality-format-scope', ['node', 'tools/quality/quality.mjs', 'format-scope', 'check']),
    step('quality-lint-inventory', [
      'node',
      'tools/quality/quality.mjs',
      'lint-inventory',
      'check',
    ]),
    step('quality-rust-toolchain', [
      'node',
      'tools/quality/quality.mjs',
      'rust-toolchain',
      'check',
    ]),
    step('quality-closure-manifest', [
      'node',
      'tools/quality/quality.mjs',
      'closure-manifest',
      'check',
    ]),
    step('tools-gates-typecheck', ['npm', 'run', 'gates:tools-typecheck']),
    step('banned-phrase', ['npm', 'run', 'gates:banned-phrase']),
    step('migration-sql', ['npm', 'run', 'gates:migration-sql']),
    step('tier-claim', ['npm', 'run', 'gates:tier-claim']),
    step('type-check-spec', ['npm', 'run', 'gates:type-check-spec']),
    step('schema-drift-registration', ['npm', 'run', 'gates:schema-drift-registration']),
    step('signals-manifest', ['npm', 'run', 'gates:signals-manifest']),
    step('criticality-manifest', ['npm', 'run', 'gates:criticality-manifest']),
    step('required-secrets', ['npm', 'run', 'validate:required-secrets']),
    step('dependency-policy', ['npm', 'run', 'gates:dependency-policy']),
    step('gha-sha-pin', ['npm', 'run', 'gates:gha-sha-pin']),
  ];
  const enterprise = [
    step('pre-clean-status', ['git', 'status', '--short'], { require_empty_stdout: true }),
    ...gatesAll,
    step('npm-ci-dry-run', ['npm', 'ci', '--dry-run', '--ignore-scripts', '--no-audit'], {
      heavy: true,
    }),
    step('npm-ci-ignore-scripts', ['npm', 'ci', '--ignore-scripts'], { heavy: true }),
    step('npm-ls-installed-tree', ['npm', 'ls', '--all'], { heavy: true }),
    step('nx-sync-check', ['node', 'tools/toolchain/run.mjs', 'nx', 'sync:check']),
    step('npm-audit', ['npm', 'audit', '--audit-level=moderate', '--omit=dev'], { heavy: true }),
    step('format-check', ['npm', 'run', 'format:check']),
    step('lint-all', ['npm', 'run', 'lint:all', '--', '--max-warnings=0'], { heavy: true }),
    step('type-check', ['npm', 'run', 'type-check'], { heavy: true }),
    step('aria-acceptance', ['npm', 'run', 'aria:acceptance'], { heavy: true }),
    step('invariants-full', ['npm', 'run', 'invariants:full'], { heavy: true }),
    step('test-all', ['npm', 'run', 'test:all'], { heavy: true }),
    step('build-all', ['npm', 'run', 'build:all'], { heavy: true }),
    step('diff-whitespace', ['git', 'diff', '--check']),
    step('post-clean-status', ['git', 'status', '--short'], { require_empty_stdout: true }),
  ];
  return {
    schema_version: 1,
    generated_by: 'tools/quality/quality.mjs closure-manifest generate',
    no_skip_acceptance: true,
    entrypoints: EXPECTED_CLOSURE_ENTRYPOINTS,
    profiles: {
      'gates-all': { readiness_claim_allowed: false, steps: gatesAll },
      'enterprise-closure': { readiness_claim_allowed: true, steps: enterprise },
    },
  };
}

function step(name, command, extra = {}) {
  return { name, command, ...extra };
}

function closureEnvironment() {
  const environment = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      environment[key] = process.env[key];
    }
  }
  return { ...environment, ...CLOSURE_ENVIRONMENT };
}

function envPolicyHash(environment) {
  const visible = {};
  for (const key of DEFAULT_ENV_ALLOWLIST.sort()) {
    if (Object.prototype.hasOwnProperty.call(environment, key)) visible[key] = '<present>';
  }
  for (const [key, value] of Object.entries(CLOSURE_ENVIRONMENT)) visible[key] = value;
  return sha256(JSON.stringify(visible));
}

function repoSha() {
  const result = run('git', ['rev-parse', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

function ariaSliceHash(environment) {
  const result = run('npm', ['run', 'aria:docs:ssot'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /aria_authority_slice_hash[:=]\s*([a-f0-9]{64})/i.exec(combined);
  return match?.[1] ?? null;
}

function runClosure(profileName) {
  const environment = closureEnvironment();
  if (profileName === 'enterprise-closure') {
    const entryStatus = run('git', ['status', '--short'], { env: environment });
    if (entryStatus.status !== 0 || (entryStatus.stdout ?? '').trim() !== '') {
      fail('[closure:enterprise-closure] bootstrap requires a clean worktree');
    }
  }
  checkClosureManifest();
  if (profileName === 'enterprise-closure') {
    const manifestStatus = run('git', ['status', '--short'], { env: environment });
    if (manifestStatus.status !== 0 || (manifestStatus.stdout ?? '').trim() !== '') {
      fail('[closure:enterprise-closure] closure-manifest check modified the worktree');
    }
  }
  const manifest = readJson(CLOSURE_MANIFEST);
  const profile = manifest.profiles[profileName];
  if (!profile) fail(`unknown closure profile: ${profileName}`);
  const runId = `${profileName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runRoot = join(EVIDENCE_ROOT, runId);
  mkdirSync(runRoot, { recursive: true });
  const seen = new Set();
  const evidence = [];
  const repo_sha = repoSha();
  const aria_slice_hash = ariaSliceHash(environment);
  for (const item of profile.steps) {
    if (seen.has(item.name)) fail(`duplicate closure step name: ${item.name}`);
    seen.add(item.name);
    const started = new Date().toISOString();
    process.stdout.write(`[closure:${profileName}] ${item.name}\n`);
    const [command, ...args] = item.command;
    const result = run(command, args, { env: environment });
    const ended = new Date().toISOString();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const log = `${stdout}${stderr}`;
    const logPath = join(runRoot, `${item.name}.log`);
    writeFileSync(logPath, log, 'utf8');
    const cleanTreeResult = run('git', ['status', '--short'], { env: environment });
    const cleanTreeOutput = cleanTreeResult.stdout ?? '';
    const record = {
      schema_version: 'TerminalRunEvidenceV1',
      run_id: runId,
      step: item.name,
      argv: item.command,
      exit_code: result.status,
      signal: result.signal,
      repo_sha,
      aria_slice_hash,
      workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
      workflow_job: process.env.GITHUB_JOB ?? null,
      workflow_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runner_identity: process.env.RUNNER_NAME ?? process.env.HOSTNAME ?? 'local',
      env_policy_hash: envPolicyHash(environment),
      clean_tree: cleanTreeResult.status === 0 && cleanTreeOutput.trim() === '',
      clean_tree_output_sha256: sha256(cleanTreeOutput),
      started_at: started,
      ended_at: ended,
      sealed_log_path: relative(REPO_ROOT, logPath).replace(/\\/g, '/'),
      log_sha256: sha256(log),
      proof_manifest_ref: null,
    };
    writeStableJson(join(runRoot, `${item.name}.terminal-run-evidence.json`), record);
    evidence.push(record);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (profile.readiness_claim_allowed && cleanTreeResult.status !== 0) {
      fail(
        `[closure:${profileName}] ${item.name} could not verify clean-tree status (exit ${cleanTreeResult.status ?? cleanTreeResult.signal})`,
      );
    }
    if (profile.readiness_claim_allowed && cleanTreeOutput.trim() !== '') {
      process.stderr.write(cleanTreeOutput);
      fail(`[closure:${profileName}] ${item.name} modified the worktree`);
    }
    if (item.require_empty_stdout && stdout.trim() !== '') {
      fail(`[closure:${profileName}] ${item.name} expected empty stdout`);
    }
    if (result.status !== 0) {
      fail(
        `[closure:${profileName}] ${item.name} failed with exit ${result.status ?? result.signal}`,
      );
    }
  }
  const bundle = {
    schema_version: 1,
    profile: profileName,
    run_id: runId,
    repo_sha,
    aria_slice_hash,
    evidence,
    evidence_count: evidence.length,
  };
  writeStableJson(join(runRoot, 'bundle.json'), bundle);
  process.stdout.write(`closure evidence bundle: ${relative(REPO_ROOT, runRoot)}\n`);
}

function parseClosureRunArgs(args) {
  let profile = null;
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg.startsWith('--skip-')) {
      fail('closure-run: skip flags are illegal for generated closure profiles');
    }
    if (arg === '--profile') {
      const value = args[idx + 1];
      if (!value || value.startsWith('-')) usage();
      if (profile !== null) fail('closure-run: duplicate --profile argument');
      profile = value;
      idx += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      if (profile !== null) fail('closure-run: duplicate --profile argument');
      profile = arg.slice('--profile='.length);
      if (!profile) usage();
      continue;
    }
    fail(`closure-run: unknown argument ${arg}`);
  }
  return profile;
}

function main() {
  const [domain, action, ...rest] = process.argv.slice(2);
  if (!domain) usage();
  if (domain === 'format-scope') {
    if (action === 'generate') return writeStableJson(FORMAT_SCOPE, buildFormatScope());
    if (action === 'check') return checkManifest(FORMAT_SCOPE, buildFormatScope);
  }
  if (domain === 'format') {
    if (action === 'check') return runPrettier('check');
    if (action === 'check-changed') return runPrettierChanged();
    if (action === 'check-staged') return runPrettierCheckStaged();
    if (action === 'write') return runPrettier('write');
    if (action === 'write-changed') return runPrettierWriteChanged();
  }
  if (domain === 'lint-inventory') {
    if (action === 'generate') return writeStableJson(LINT_INVENTORY, buildLintInventory());
    if (action === 'check') return checkManifest(LINT_INVENTORY, buildLintInventory);
  }
  if (domain === 'lint-all') return runLintAll();
  if (domain === 'rust-toolchain') {
    if (action === 'generate') return writeStableJson(RUST_MANIFEST, buildRustManifest());
    if (action === 'check') return checkRustToolchain();
  }
  if (domain === 'closure-manifest') {
    if (action === 'generate') return writeClosureManifest();
    if (action === 'check') return checkClosureManifest();
  }
  if (domain === 'inventory') {
    if (action === 'generate') {
      writeStableJson(FORMAT_SCOPE, buildFormatScope());
      writeStableJson(LINT_INVENTORY, buildLintInventory());
      writeStableJson(RUST_MANIFEST, buildRustManifest());
      writeClosureManifest();
      return;
    }
    if (action === 'check') {
      checkManifest(FORMAT_SCOPE, buildFormatScope);
      checkManifest(LINT_INVENTORY, buildLintInventory);
      checkManifest(RUST_MANIFEST, buildRustManifest);
      checkClosureManifest();
      return;
    }
  }
  if (domain === 'closure-run') {
    const profile = parseClosureRunArgs([action, ...rest]);
    if (!profile) usage();
    return runClosure(profile);
  }
  usage();
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
