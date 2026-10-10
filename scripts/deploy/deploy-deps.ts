#!/usr/bin/env node
/**
 * Deploy-owned Node dependency tree for the SHA-pinned deploy checkout
 * (INFRA-HIGH-218).
 *
 * WHY THIS EXISTS: the deploy runs third-party-importing TS scripts from
 * DEPLOY_CHECKOUT_DIR (check-service-health.ts / assert-service-signals.ts →
 * `import yaml from 'js-yaml'`). ORPHAN-HIGH-250 made them resolve by
 * symlinking the INTERACTIVE source repo's node_modules into the checkout. That
 * tree belongs to engineering/agent sessions: on 2026-10-10 a session ran
 * `npm ci` in a worktree whose node_modules was itself a symlink to it, npm
 * emptied the target, and the development deploy of 1b64b69cb died at
 * critical_health with ERR_MODULE_NOT_FOUND js-yaml — and the rollback ran the
 * same broken gate (rollback_failed). A production deploy may not depend on
 * mutable state another actor owns.
 *
 * WHAT IT DOES: the deploy owns its dependencies. Each distinct
 * package-lock.json of a deploy SHA is installed ONCE with `npm ci` into
 *   <root>/<key>/node_modules        (key = sha256(recipe + lockfile))
 * built in a staging dir, verified, then renamed into place (atomic on one
 * filesystem), and the checkout's `node_modules` becomes a symlink to it,
 * swapped atomically. A later deploy with the same lockfile reuses the tree
 * (verified, no network). Retention keeps the current key plus the previous
 * one, so redeploying the prior SHA still resolves without a network install.
 *
 * INSTALL RECIPE: `npm ci --ignore-scripts --omit=dev`, keyed by
 * sha256(recipe + npm major + project .npmrc + package-lock.json).
 *   --ignore-scripts: the root `prepare` script installs husky hooks and git
 *     merge drivers into the git config the deploy worktree SHARES with the
 *     source repo; a deploy must not write that. The deploy scripts' only
 *     third-party import is js-yaml (pure JS, no install script), and every
 *     deploy-script import is verified to load after the install, so a future
 *     dependency that needs an install script fails here, before any
 *     production state changes, instead of at the health gate.
 *   --omit=dev: the deploy scripts may import only root `dependencies`
 *     (enforced by tests/invariants/deploy-owned-dependencies.spec.ts); this
 *     keeps the tree at ~1.2 GB instead of ~1.8 GB.
 *   The npm cache, user and global config are deploy-owned too (inside the
 *   staging dir, discarded after the install), and npm runs with a minimal
 *   environment (PATH, HOME, proxies): no deploy secret such as GHCR_TOKEN,
 *   no NODE_OPTIONS, no ambient npm_config_*.
 *
 * Locking is the caller's job: deploy-paths.sh wraps `provision` in an
 * exclusive flock(1) and `verify` in a shared one on <root>/.lock.
 *
 * Commands (all take --checkout <abs dir> --root <abs dir>):
 *   provision  install-or-reuse, link the checkout, record + prune retention
 *   verify     assert the checkout's node_modules is the deploy-owned tree for
 *              its lockfile and that every deploy-script import loads from it
 *   plan       print the bytes provisioning would add (0 when reusable) — the
 *              capacity preflight projects this before anything is written
 *   key        print the dependency key of the checkout's lockfile
 *   imports    print the bare specifiers the deploy scripts load (JSON),
 *              following relative imports through the checkout
 *
 * Node builtins only: this runs BEFORE any node_modules exists.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Bump when the install recipe changes, so old trees are not reused. */
const RECIPE_VERSION = 'aqua-deploy-deps/v1';
const NPM_CI_ARGS: readonly string[] = [
  'ci',
  '--ignore-scripts',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
];
/** Current + previous key. A rollback redeploy of the prior SHA reuses it. */
const RETAINED_KEYS = 2;
const MARKER = '.deploy-deps.json';
const HISTORY = 'history.json';
const STAGING_PREFIX = '.staging-';
const KEY_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * Capacity projection when no install has been measured on this host yet:
 * the measured omit-dev tree is ~1.2 GiB plus a ~0.2 GiB transient npm cache.
 */
const FALLBACK_INSTALL_ESTIMATE_BYTES = 2 * 1024 * 1024 * 1024;
/** Measured tree size × this factor covers the transient cache + growth. */
const MEASURED_ESTIMATE_FACTOR = 1.5;
const NPM_TIMEOUT_MS = 20 * 60 * 1000;
const LOAD_TIMEOUT_MS = 60 * 1000;
/** Network proxy settings are the only ambient variables npm may inherit. */
const PASSTHROUGH_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

interface Marker {
  key: string;
  recipe: string;
  lockSha256: string;
  npmMajor: string;
  npmArgs: string[];
  specifiers: string[];
  installedBytes: number;
  createdAt: string;
}

interface Options {
  checkout: string;
  root: string;
}

/**
 * The exact install input, read ONCE from the checkout. The key is computed
 * from these bytes and the same bytes are written to staging, so a checkout
 * re-pinned mid-provision can never store lockfile B's tree under key(A).
 */
interface InstallInput {
  lock: Buffer;
  npmrc: Buffer | null;
  packageJson: Buffer;
  npmMajor: string;
}

class DeployDepsError extends Error {}

function fail(message: string): never {
  throw new DeployDepsError(message);
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--checkout' && flag !== '--root') || value === undefined) {
      fail(`unexpected argument ${String(flag)}; expected --checkout <dir> --root <dir>`);
    }
    values.set(flag, value);
  }
  const checkout = values.get('--checkout');
  const root = values.get('--root');
  if (checkout === undefined || root === undefined) {
    fail('--checkout and --root are both required');
  }
  if (!isAbsolute(checkout) || !isAbsolute(root)) {
    fail('--checkout and --root must be absolute paths');
  }
  return { checkout, root };
}

/**
 * Minimal environment for every child (npm and the import probe): no deploy
 * secrets (GHCR_TOKEN, …), no NODE_OPTIONS, no ambient npm_config_*.
 */
function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home };
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

function npmMajorVersion(): string {
  const result = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    env: childEnv(tmpdir(), { npm_config_update_notifier: 'false' }),
    timeout: LOAD_TIMEOUT_MS,
  });
  const major = /^(\d+)\./u.exec(result.stdout.trim())?.[1];
  if (result.status !== 0 || major === undefined) fail('cannot determine the npm version');
  return major;
}

function readInput(checkout: string): InstallInput {
  const lockPath = join(checkout, 'package-lock.json');
  const pkgPath = join(checkout, 'package.json');
  if (!existsSync(lockPath) || !existsSync(pkgPath)) {
    fail(`no package.json/package-lock.json in ${checkout}`);
  }
  const npmrcPath = join(checkout, '.npmrc');
  return {
    lock: readFileSync(lockPath),
    npmrc: existsSync(npmrcPath) ? readFileSync(npmrcPath) : null,
    packageJson: readFileSync(pkgPath),
    npmMajor: npmMajorVersion(),
  };
}

/**
 * Dependency key: install recipe + npm major + project .npmrc + exact lockfile
 * bytes. Everything that decides what `npm ci` puts on disk.
 */
function keyOf(input: Pick<InstallInput, 'lock' | 'npmrc' | 'npmMajor'>): string {
  return createHash('sha256')
    .update(`${RECIPE_VERSION}\n${NPM_CI_ARGS.join(' ')}\nnpm@${input.npmMajor}\n`)
    .update(input.npmrc ?? Buffer.alloc(0))
    .update('\n--lock--\n')
    .update(input.lock)
    .digest('hex');
}

/** Re-derive a key dir's key from the bytes it was installed from. */
function keyOfDir(keyDir: string, npmMajor: string): string | null {
  const lockPath = join(keyDir, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  const npmrcPath = join(keyDir, '.npmrc');
  return keyOf({
    lock: readFileSync(lockPath),
    npmrc: existsSync(npmrcPath) ? readFileSync(npmrcPath) : null,
    npmMajor,
  });
}

const SCRIPT_FILE = /\.(?:ts|mts|mjs|js|cjs)$/u;

function walkDeployScripts(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') walkDeployScripts(path, out);
    } else if (SCRIPT_FILE.test(entry.name) && !/\.spec\.[a-z]+$/u.test(entry.name)) {
      out.push(path);
    }
  }
}

/**
 * Bare (package) specifiers the deploy scripts load: every script under
 * scripts/deploy/** plus, transitively, every checkout file they import by a
 * relative path (a helper outside scripts/deploy importing a package counts
 * too). Node builtins are excluded; what remains must resolve from the
 * deploy-owned tree. Derived from the checkout, so a new import is verified
 * automatically.
 */
function deployScriptSpecifiers(checkout: string): string[] {
  const queue: string[] = [];
  walkDeployScripts(join(checkout, 'scripts', 'deploy'), queue);
  const realCheckout = realpathSync(checkout);
  const seen = new Set<string>();
  const builtins = new Set(builtinModules);
  const found = new Set<string>();
  const patterns = [
    /^\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gmu,
    /^\s*export\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/gmu,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        if (spec === undefined) continue;
        // `import type` is erased by type-stripping; it never loads at runtime.
        if (/^\s*import\s+type\s/u.test(match[0])) continue;
        if (spec.startsWith('.')) {
          const target = join(dirname(file), spec);
          if (
            SCRIPT_FILE.test(target) &&
            existsSync(target) &&
            isWithin(realpathSync(target), realCheckout)
          ) {
            queue.push(realpathSync(target));
          }
          continue;
        }
        if (spec.startsWith('/') || spec.startsWith('node:')) continue;
        if (builtins.has(spec) || builtins.has(spec.split('/')[0] ?? '')) continue;
        found.add(spec);
      }
    }
  }
  return [...found].sort();
}

/**
 * Load every specifier from `cwd` exactly the way the deploy scripts resolve
 * it (walk up from the script's directory), and return the resolved real paths.
 */
function loadSpecifiers(cwd: string, specifiers: readonly string[]): string[] {
  if (specifiers.length === 0) return [];
  const program = [
    "import { realpathSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    'const out = [];',
    'for (const s of JSON.parse(process.argv[1])) {',
    '  await import(s);',
    '  out.push(realpathSync(fileURLToPath(import.meta.resolve(s))));',
    '}',
    // Last line only: a module that prints on import cannot corrupt the result.
    "process.stdout.write('\\n' + JSON.stringify(out) + '\\n');",
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', program, JSON.stringify(specifiers)],
    { cwd, encoding: 'utf8', env: childEnv(tmpdir()), timeout: LOAD_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    fail(`deploy-script dependencies do not load from ${cwd}: ${reason}`);
  }
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '[]') as string[];
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function readMarker(keyDir: string): Marker | null {
  const path = join(keyDir, MARKER);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Marker;
  } catch {
    return null;
  }
}

/**
 * A key dir is reusable only if the bytes it was installed from still hash to
 * the key, its marker agrees, and every deploy-script import loads from it.
 */
function isReusable(
  keyDir: string,
  key: string,
  npmMajor: string,
  specifiers: readonly string[],
): boolean {
  const marker = readMarker(keyDir);
  if (marker?.key !== key || marker.recipe !== RECIPE_VERSION) return false;
  if (keyOfDir(keyDir, npmMajor) !== key) return false;
  if (!existsSync(join(keyDir, 'node_modules'))) return false;
  try {
    const resolved = loadSpecifiers(keyDir, specifiers);
    const realKeyDir = realpathSync(keyDir);
    return resolved.every((path) => isWithin(path, realKeyDir));
  } catch {
    return false;
  }
}

function readHistory(root: string): string[] {
  const path = join(root, HISTORY);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === 'string' && KEY_PATTERN.test(k))
      : [];
  } catch {
    return [];
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Last `n` entries; `n <= 0` is empty (`slice(-0)` would return everything). */
function lastN(items: readonly string[], n: number): string[] {
  return n <= 0 ? [] : items.slice(Math.max(0, items.length - n));
}

/**
 * The key the checkout is linked to right now, if it points into the root.
 * Derived from the link itself — not from history — so a crash between the
 * link swap and the history write can never get the live tree pruned.
 */
function liveKey(opts: Options): string | null {
  const link = join(opts.checkout, 'node_modules');
  if (!existsSync(link) || !existsSync(opts.root)) return null;
  const rel = relative(realpathSync(opts.root), realpathSync(link)).split(sep);
  return rel.length === 2 && KEY_PATTERN.test(rel[0] ?? '') && rel[1] === 'node_modules'
    ? (rel[0] ?? null)
    : null;
}

/**
 * Delete every key dir not in `keep` and every staging leftover. Runs under
 * the exclusive lock, so no staging dir can belong to a live install.
 */
function prune(root: string, keep: readonly string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stale =
      entry.name.startsWith(STAGING_PREFIX) ||
      (KEY_PATTERN.test(entry.name) && !keep.includes(entry.name));
    if (stale) {
      log(`  pruning ${join(root, entry.name)}`);
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function workspaceManifestDirs(lock: Buffer): string[] {
  const parsed = JSON.parse(lock.toString('utf8')) as { packages?: Record<string, unknown> };
  return Object.keys(parsed.packages ?? {}).filter(
    (path) => path !== '' && !path.startsWith('node_modules/') && !path.includes('/node_modules/'),
  );
}

function diskBytes(path: string): number {
  const result = spawnSync('du', ['-sB1', path], { encoding: 'utf8' });
  const bytes = Number.parseInt(result.stdout.split('\t')[0] ?? '', 10);
  if (result.status !== 0 || !Number.isFinite(bytes)) fail(`du failed for ${path}`);
  return bytes;
}

/**
 * npm ci for `input` in a fresh staging dir, verified, then renamed to
 * `keyDir`. On ANY failure the staging dir is removed before the error
 * propagates, so a failed install leaves nothing for the next capacity gate.
 */
function installKey(
  opts: Options,
  input: InstallInput,
  key: string,
  specifiers: readonly string[],
): void {
  const staging = join(opts.root, `${STAGING_PREFIX}${key}-${process.pid}`);
  const pkg = join(staging, 'pkg');
  const cache = join(staging, 'npm-cache');
  // Two files: npm refuses to load one path as both user and global config.
  const userConfig = join(staging, 'npmrc-user-empty');
  const globalConfig = join(staging, 'npmrc-global-empty');
  try {
    mkdirSync(pkg, { recursive: true });
    mkdirSync(cache);
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');

    // npm ci validates the lockfile against the root and workspace manifests,
    // so those (and the project .npmrc policy) are the whole install input.
    // The keyed bytes are written verbatim; nothing else of the checkout is
    // copied: the tree is a pure function of the key.
    writeFileSync(join(pkg, 'package-lock.json'), input.lock);
    writeFileSync(join(pkg, 'package.json'), input.packageJson);
    if (input.npmrc !== null) writeFileSync(join(pkg, '.npmrc'), input.npmrc);
    for (const ws of workspaceManifestDirs(input.lock)) {
      const src = join(opts.checkout, ws, 'package.json');
      if (!existsSync(src)) fail(`workspace manifest missing in checkout: ${ws}/package.json`);
      mkdirSync(join(pkg, ws), { recursive: true });
      writeFileSync(join(pkg, ws, 'package.json'), readFileSync(src));
    }

    log(`  npm ${NPM_CI_ARGS.join(' ')} (key ${key})`);
    const npm = spawnSync('npm', [...NPM_CI_ARGS], {
      cwd: pkg,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: NPM_TIMEOUT_MS,
      env: childEnv(staging, {
        npm_config_cache: cache,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_update_notifier: 'false',
      }),
    });
    if (npm.status !== 0) {
      fail(
        `npm ci failed (status ${String(npm.status)}${npm.error ? `, ${npm.error.message}` : ''})`,
      );
    }

    const resolved = loadSpecifiers(pkg, specifiers);
    const realPkg = realpathSync(pkg);
    const outside = resolved.filter((path) => !isWithin(path, realPkg));
    if (outside.length > 0) fail(`staged install resolved outside itself: ${outside.join(', ')}`);

    rmSync(cache, { recursive: true, force: true });
    const marker: Marker = {
      key,
      recipe: RECIPE_VERSION,
      lockSha256: createHash('sha256').update(input.lock).digest('hex'),
      npmMajor: input.npmMajor,
      npmArgs: [...NPM_CI_ARGS],
      specifiers: [...specifiers],
      installedBytes: diskBytes(pkg),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(pkg, MARKER), `${JSON.stringify(marker)}\n`);
    renameSync(pkg, join(opts.root, key));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Point <checkout>/node_modules at the key's tree with one rename(2). */
function linkCheckout(checkout: string, keyDir: string): void {
  const link = join(checkout, 'node_modules');
  const tmp = join(checkout, `.node_modules.tmp-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(join(keyDir, 'node_modules'), tmp);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isSymbolicLink()) {
    // A real directory cannot be replaced by rename; it is never the
    // deploy-owned tree (that is always a symlink), so remove it.
    rmSync(link, { recursive: true, force: true });
  }
  renameSync(tmp, link);
}

function assertCheckoutResolves(
  opts: Options,
  key: string,
  npmMajor: string,
  specifiers: readonly string[],
): void {
  const keyDir = join(opts.root, key);
  const link = join(opts.checkout, 'node_modules');
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isSymbolicLink() || !existsSync(link)) {
    fail(`${link} is not a live symlink to the deploy-owned dependency tree`);
  }
  if (!existsSync(join(keyDir, 'node_modules'))) {
    fail(`no deploy-owned dependency tree for key ${key} under ${opts.root}`);
  }
  const expected = realpathSync(join(keyDir, 'node_modules'));
  if (realpathSync(link) !== expected) {
    fail(`${link} resolves to ${realpathSync(link)}, expected ${expected}`);
  }
  if (readMarker(keyDir)?.key !== key || keyOfDir(keyDir, npmMajor) !== key) {
    fail(`${keyDir} was not installed from the bytes of key ${key}`);
  }
  // Resolve from where the deploy scripts live, exactly as they will.
  const resolved = loadSpecifiers(join(opts.checkout, 'scripts', 'deploy'), specifiers);
  const realKeyDir = realpathSync(keyDir);
  const outside = resolved.filter((path) => !isWithin(path, realKeyDir));
  if (outside.length > 0) {
    fail(`deploy-script imports resolve outside ${realKeyDir}: ${outside.join(', ')}`);
  }
}

function provision(opts: Options): void {
  mkdirSync(opts.root, { recursive: true });
  const input = readInput(opts.checkout);
  const key = keyOf(input);
  const specifiers = deployScriptSpecifiers(opts.checkout);
  const keyDir = join(opts.root, key);
  const live = liveKey(opts);
  const history = readHistory(opts.root).filter((k) => existsSync(join(opts.root, k)));
  // The tree to keep as "previous": whatever the checkout is linked to now,
  // else the most recent other key on record.
  const others = [...history, ...(live === null ? [] : [live])].filter(
    (k, i, all) => k !== key && all.lastIndexOf(k) === i,
  );
  const previous = lastN(others, RETAINED_KEYS - 1);

  if (isReusable(keyDir, key, input.npmMajor, specifiers)) {
    log(`  reusing deploy-owned dependencies ${keyDir}`);
  } else {
    // Bound the peak footprint: before a new install keep only the previous
    // tree (always including the live one), plus nothing partial.
    rmSync(keyDir, { recursive: true, force: true });
    prune(opts.root, previous);
    installKey(opts, input, key, specifiers);
    log(`  installed deploy-owned dependencies ${keyDir}`);
  }

  // History first: if anything below dies, the new key AND the previously
  // live key are both on record, so neither can be pruned by the next run.
  const nextHistory = [...previous, key];
  writeAtomic(join(opts.root, HISTORY), `${JSON.stringify(nextHistory)}\n`);
  linkCheckout(opts.checkout, keyDir);
  assertCheckoutResolves(opts, key, input.npmMajor, specifiers);
  prune(opts.root, nextHistory);
  log(`  deploy checkout node_modules -> ${join(keyDir, 'node_modules')}`);
}

function verify(opts: Options): void {
  if (!existsSync(opts.root)) fail(`deploy-owned dependency root ${opts.root} does not exist`);
  const input = readInput(opts.checkout);
  const key = keyOf(input);
  assertCheckoutResolves(opts, key, input.npmMajor, deployScriptSpecifiers(opts.checkout));
  log(`  deploy-owned dependencies verified (key ${key})`);
}

/** Bytes provisioning would add on the deps filesystem; 0 when reusable. */
function plan(opts: Options): number {
  const input = readInput(opts.checkout);
  const key = keyOf(input);
  const keyDir = join(opts.root, key);
  if (existsSync(opts.root) && readMarker(keyDir)?.key === key) return 0;
  const measured = existsSync(opts.root)
    ? readdirSync(opts.root)
        .filter((name) => KEY_PATTERN.test(name))
        .map((name) => readMarker(join(opts.root, name))?.installedBytes ?? 0)
    : [];
  const largest = Math.max(0, ...measured);
  return largest > 0
    ? Math.ceil(largest * MEASURED_ESTIMATE_FACTOR)
    : FALLBACK_INSTALL_ESTIMATE_BYTES;
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  try {
    const opts = parseOptions(rest);
    switch (command) {
      case 'provision':
        provision(opts);
        return 0;
      case 'verify':
        verify(opts);
        return 0;
      case 'plan':
        process.stdout.write(`${plan(opts)}\n`);
        return 0;
      case 'key':
        process.stdout.write(`${keyOf(readInput(opts.checkout))}\n`);
        return 0;
      case 'imports':
        process.stdout.write(`${JSON.stringify(deployScriptSpecifiers(opts.checkout))}\n`);
        return 0;
      default:
        fail(`unknown command ${String(command)}; expected provision|verify|plan|key|imports`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::deploy-deps: ${message}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
