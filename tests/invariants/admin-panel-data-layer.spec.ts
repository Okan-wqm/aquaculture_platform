/**
 * INVARIANT — the admin-panel's data layer has ONE cache authority, and every
 * cache in the web tree is cleared by logout (ADMIN-HIGH-121).
 *
 * Three failures this pins, each of which was live before W8a:
 *
 *   1. **A second cache nothing clears.** `useAsyncData` holds cross-tenant
 *      SUPER_ADMIN data — billing metrics, audit logs with their tenant list,
 *      usage rollups — in a module-scoped Map. It waited on an
 *      `aquaculture:logout` window event that NOTHING in the repository
 *      dispatches, so it survived logout and served the previous principal's
 *      platform data to the next one on the same tab. `logoutCleanup()` is the
 *      platform's single logout authority and `registerLogoutCleanup` is how a
 *      module joins it; a module-scoped cache that joins neither is the bug.
 *
 *   2. **A migration that stalls silently.** The reads still on `useAsyncData`
 *      cannot be invalidated by a write, so their lists go stale after a
 *      mutation. The remaining call sites are a governed ratchet, not a TODO:
 *      each names its page, its count, an owner, an expiry and the finding.
 *
 *   3. **A phantom dependency.** admin-panel imported `@tanstack/react-query`
 *      without declaring it, resolving only through the Module Federation
 *      shared-scope at runtime. A standalone build or a federation config
 *      change breaks it with no compile-time signal, and the version it gets
 *      is whatever the host happens to load. Every web package that imports it
 *      must declare it at the version `federationSharedConfig` pins.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '../..');
const ALLOWLIST = '.claude/allowlists/admin-panel-unmigrated-reads.yaml';
const ADMIN_PANEL = 'web/modules/admin-panel';
const FEDERATION_CONFIG = 'web/shared-ui/src/federation/federationSharedConfig.ts';
const REACT_QUERY = '@tanstack/react-query';

/** A direct import of an admin REST client — `services/adminApi` or `services/api/*`. */
const IMPORTS_API_CLIENT = /from\s+'[^']*(?:services\/adminApi|services\/api\/)[^']*'/;
/** Naming either primitive means the page reaches the network through the data layer. */
const USES_DATA_LAYER = /\buseAdmin(?:Query|Mutation|GraphQLQuery|GraphQLMutation)\b/;

interface AllowlistEntry {
  site: string;
  batch: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

/**
 * Tracked files under `roots`, filtered by extension in JS.
 *
 * NOT a `**` pathspec: git's wildmatch does not expand `dir/**\/*.tsx` to
 * nested files the way a shell glob would, and the silent result is a short
 * file list that makes every assertion below vacuously true. Listing the
 * directory and filtering here cannot go quiet that way — and the
 * `sees the admin-panel pages` case pins the count so a future refactor of
 * this helper cannot either.
 */
function gitFiles(roots: string[], extensions: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...roots], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file !== '' && extensions.some((ext) => file.endsWith(ext)));
}

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/** A docstring naming a symbol is not a use of it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function expiryIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/**
 * A page is unmigrated when it imports an admin API client directly and names
 * neither primitive — the one criterion that covers `useAsyncData(fetcher)` and
 * a bare `useEffect(() => { void somethingApi.get() })` alike, because what
 * matters is that the result lands outside the shell's QueryClient, not which
 * helper ran the fetch.
 */
function isUnmigrated(source: string): boolean {
  const code = stripComments(source);
  return IMPORTS_API_CLIENT.test(code) && !USES_DATA_LAYER.test(code);
}

describe('INVARIANT (ADMIN-HIGH-121): the admin-panel data layer', () => {
  // A page's own SPEC lives under `pages/__tests__/` and imports the api client
  // to mock it, so an unfiltered listing counts it as an unmigrated page. That
  // is not a harmless overcount: it inflates the ceiling, and it would let a
  // real page hide behind the "migration" of a test file.
  const pageFiles = gitFiles([`${ADMIN_PANEL}/src/pages`], ['.tsx']).filter(
    (file) => !/__tests__/.test(file) && !/\.(spec|test)\.tsx$/.test(file),
  );
  const unmigrated = new Set(pageFiles.filter((file) => isUnmigrated(read(file))));

  const doc = yaml.load(read(ALLOWLIST)) as {
    ceiling?: number;
    entries?: AllowlistEntry[];
  };
  const ceiling = doc.ceiling ?? 0;
  const entries = doc.entries ?? [];
  const today = new Date().toISOString().slice(0, 10);

  it('sees the admin-panel pages', () => {
    // A path typo or a moved directory would otherwise make every assertion
    // below vacuously true.
    expect(pageFiles.length).toBeGreaterThan(30);
  });

  it('ratchets every unmigrated page — governed, live, and only shrinking', () => {
    const listed = new Set(entries.map((entry) => entry.site));

    // Every unmigrated page is listed: a new page cannot ship outside the data
    // layer without saying so.
    expect([...unmigrated].filter((file) => !listed.has(file)).sort()).toEqual([]);

    // Every listed page is still unmigrated: a finished page cannot be left on
    // the list to hold the ceiling up while the number looks like progress.
    expect([...listed].filter((file) => !unmigrated.has(file)).sort()).toEqual([]);

    for (const entry of entries) {
      expect(entry.owner).toBeTruthy();
      expect(entry.batch).toMatch(/^(tenant|billing|security|system|messaging)$/);
      expect(entry.findingId).toMatch(/^[A-Z]+-[A-Z]+-\d+$/);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(expiryIso(entry.expiry) > today).toBe(true);
    }

    expect(unmigrated.size).toBeLessThanOrEqual(ceiling);
    expect(entries.length).toBeLessThanOrEqual(ceiling);
  });

  it('clears every module-scoped cache in the web tree through the logout authority', () => {
    // A `const cache = new Map(...)` at module scope survives navigation and
    // survives logout unless something clears it. The platform has exactly one
    // mechanism for that — `registerLogoutCleanup`, which `logoutCleanup()`
    // drains — so a file that declares such a cache must name it. A file that
    // only READS a cache someone else owns is not caught, and should not be.
    const sourceFiles = gitFiles(
      ['web/modules', 'web/shell/src', 'web/shared-ui/src', 'web/apps'],
      ['.ts', '.tsx'],
    ).filter(
      (file) =>
        !/\.(spec|test)\.tsx?$/.test(file) &&
        !/__tests__/.test(file) &&
        !file.includes('/node_modules/'),
    );

    const unregistered: string[] = [];
    for (const file of sourceFiles) {
      const source = stripComments(read(file));
      const declaresCache = /^const\s+\w*[Cc]ache\w*\s*(?::[^=]+)?=\s*new\s+Map[<(]/m.test(source);
      if (!declaresCache) continue;
      if (!/registerLogoutCleanup\s*\(/.test(source)) unregistered.push(file);
    }

    expect(unregistered).toEqual([]);
  });

  it('declares @tanstack/react-query wherever it is imported, at the federation-pinned version', () => {
    const pinned = /'@tanstack\/react-query':\s*'([^']+)'/.exec(read(FEDERATION_CONFIG))?.[1];
    expect(pinned).toBeTruthy();

    const packageFiles = gitFiles(['web'], ['/package.json']).filter(
      (file) => !file.includes('/node_modules/'),
    );
    const violations: string[] = [];

    for (const packageFile of packageFiles) {
      const packageDir = packageFile.replace(/\/package\.json$/, '');
      const sources = gitFiles([`${packageDir}/src`], ['.ts', '.tsx']);
      const imports = sources.some((file) =>
        new RegExp(`from ['"]${REACT_QUERY}['"]`).test(read(file)),
      );
      if (!imports) continue;

      const manifest = JSON.parse(read(packageFile)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const declared =
        manifest.dependencies?.[REACT_QUERY] ??
        manifest.devDependencies?.[REACT_QUERY] ??
        manifest.peerDependencies?.[REACT_QUERY];

      if (declared === undefined) violations.push(`${packageFile}: imports but does not declare`);
      else if (declared !== pinned)
        violations.push(`${packageFile}: declares ${declared}, federation pins ${pinned}`);
    }

    expect(violations).toEqual([]);
  });

  it('keeps the admin-panel hooks barrel exporting the sanctioned primitives', () => {
    // The primitives existed for a release and no page could reach them: they
    // were written, documented, and never exported. That is the failure this
    // asserts against — a barrel that forgets one of them puts the next page
    // back on `useAsyncData` with no signal.
    // stripComments matters here: the barrel's own docblock names all three, so
    // a raw grep passes on a file whose exports were deleted.
    const barrel = stripComments(read(`${ADMIN_PANEL}/src/hooks/index.ts`));
    for (const symbol of ['useAdminQuery', 'useAdminMutation', 'adminKeys']) {
      expect(barrel).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`));
    }
    expect(existsSync(resolve(REPO_ROOT, ALLOWLIST))).toBe(true);
  });
});
