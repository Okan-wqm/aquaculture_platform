/**
 * Invariant: federated web runtime code must consume shared-ui through the
 * public `@aquaculture/shared-ui` package entrypoint, and that entrypoint must
 * reach the Module Federation share scope in every federation build.
 *
 * Module Federation relies on that package specifier as the singleton identity
 * for React contexts. Two paths create a second module identity in production
 * bundles, and both end in the same Provider/Hook split: AuthProvider or
 * TenantProvider exists, but a remote or shell hook reads a different context
 * instance and throws at runtime.
 *
 *   1. A deep source import such as `../../../shared-ui/src/...` in runtime code.
 *   2. A `resolve.alias` entry in a federation vite config that rewrites a
 *      federation-shared specifier to a file path. Vite's alias plugin runs
 *      before every user plugin, so `@module-federation/vite` receives the path,
 *      not the package name, and never routes the import through `loadShare`.
 *      The remote then imports its own bundled copy directly. That is how the
 *      dashboard remote rendered "useTenantContext must be used within a
 *      TenantProvider" under the shell's TenantProvider (FE-HIGH-343): shell and
 *      all eight remotes aliased `@aquaculture/shared-ui` to `web/shared-ui/dist`
 *      in every mode, so each bundle carried a private shared-ui.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SHARED_VERSIONS } from '../../web/shared-ui/src/federation/federationSharedConfig';
import {
  SHARED_UI_TEST_MODE,
  sharedUiAlias,
} from '../../web/shared-ui/src/federation/sharedUiAlias';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEB_RUNTIME_GLOBS = [
  'web/shell/src/**/*.ts',
  'web/shell/src/**/*.tsx',
  'web/modules/*/src/**/*.ts',
  'web/modules/*/src/**/*.tsx',
] as const;

const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /\.spec\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.ts$/,
  /\.test\.tsx$/,
  /\.d\.ts$/,
] as const;

/** Every specifier the federation SSoT shares as a singleton. */
const FEDERATION_SHARED_KEYS: readonly string[] = Object.keys(SHARED_VERSIONS);

interface Hit {
  file: string;
  line: number;
  specifier: string;
}

function gitLsFiles(globs: readonly string[]): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...globs], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function listRuntimeFiles(): readonly string[] {
  return gitLsFiles(WEB_RUNTIME_GLOBS).filter(
    (file) => !EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

/**
 * Static import/export statements, matched over the whole file so a
 * multi-line `import {\n  A,\n} from '...'` is seen as one statement.
 */
const IMPORT_SPECIFIER_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function scanFile(file: string): readonly Hit[] {
  const content = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const hits: Hit[] = [];

  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? '';
    if (specifier.includes('shared-ui/src/')) {
      const statementStart = (match.index ?? 0) + match[0].search(/\S/);
      hits.push({ file, line: lineOf(content, statementStart), specifier });
    }
  }

  return hits;
}

/** Vite's string-alias rule: `find` matches the id itself or any subpath. */
function aliasShadows(find: string, sharedKey: string): boolean {
  return find === sharedKey || sharedKey.startsWith(`${find}/`);
}

/** Federation vite configs (the shell host and every remote). */
function federationViteConfigs(): readonly string[] {
  return gitLsFiles(['web/shell/vite.config.ts', 'web/modules/*/vite.config.ts']).filter((file) =>
    readFileSync(resolve(REPO_ROOT, file), 'utf-8').includes('federation('),
  );
}

/** Alias `find` values a config spells itself: object keys and `find:` strings. */
function spelledAliasFinds(file: string): readonly { find: string; line: number }[] {
  const code = readFileSync(resolve(REPO_ROOT, file), 'utf-8')
    // Blank comments out but keep their newlines so line numbers stay true.
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
  const finds: { find: string; line: number }[] = [];
  for (const match of code.matchAll(/['"]([^'"\n]+)['"]\s*:/g)) {
    finds.push({ find: match[1] ?? '', line: lineOf(code, match.index ?? 0) });
  }
  for (const match of code.matchAll(/\bfind\s*:\s*['"]([^'"\n]+)['"]/g)) {
    finds.push({ find: match[1] ?? '', line: lineOf(code, match.index ?? 0) });
  }
  return finds;
}

describe('INVARIANT: federated web runtime imports shared-ui through one singleton package identity', () => {
  const hits = listRuntimeFiles().flatMap((file) => [...scanFile(file)]);

  it('does not deep-import shared-ui source files from shell or remote modules', () => {
    if (hits.length > 0) {
      const details = hits.map((hit) => `  ${hit.file}:${hit.line} -> ${hit.specifier}`).join('\n');

      throw new Error(
        `Found ${hits.length} shared-ui deep source import(s):\n${details}\n\n` +
          `Use the public '@aquaculture/shared-ui' entrypoint instead. ` +
          `Deep source imports create duplicate React context module identities ` +
          `under Module Federation and can break AuthProvider/TenantProvider at runtime.`,
      );
    }

    expect(hits).toEqual([]);
  });

  it('sees a multi-line deep import as one statement', () => {
    // A line-by-line scan reads only `} from '...'` on the last line and misses it.
    const sample =
      "import {\n  useTenantContext,\n} from '../../shared-ui/src/contexts/TenantContext';";
    const specifiers = [...sample.matchAll(IMPORT_SPECIFIER_RE)].map((match) => match[1]);
    expect(specifiers).toEqual(['../../shared-ui/src/contexts/TenantContext']);
  });
});

describe('INVARIANT: no federation build resolves a shared singleton around the share scope (FE-HIGH-343)', () => {
  const configs = federationViteConfigs();

  it('finds the shell and every remote config', () => {
    // A walker that matched nothing would make the cases below vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(9);
    expect(FEDERATION_SHARED_KEYS).toContain('@aquaculture/shared-ui');
  });

  it('no federation vite config aliases a federation-shared specifier', () => {
    const offenders = configs.flatMap((file) =>
      spelledAliasFinds(file)
        .filter(({ find }) => FEDERATION_SHARED_KEYS.some((key) => aliasShadows(find, key)))
        .map(({ find, line }) => `${file}:${line} aliases '${find}'`),
    );

    expect(offenders).toEqual([]);
  });

  it('the shared-ui alias resolver shadows no shared specifier outside test mode', () => {
    const root = '/repo/web/shared-ui';
    const offenders = ['production', 'development', 'staging', ''].flatMap((mode) =>
      Object.keys(sharedUiAlias(root, mode))
        .filter((find) => FEDERATION_SHARED_KEYS.some((key) => aliasShadows(find, key)))
        .map((find) => `mode '${mode}' aliases '${find}'`),
    );

    expect(offenders).toEqual([]);
    // Under vitest no federation runtime exists; the source alias is the point.
    expect(Object.keys(sharedUiAlias(root, SHARED_UI_TEST_MODE))).toEqual([
      '@aquaculture/shared-ui',
    ]);
  });
});
