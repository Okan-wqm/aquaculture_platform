/**
 * Repo Hygiene Invariants (A4 — dead-weight) — INFRA-MEDIUM-036
 * ============================================================================
 *
 * A4 removed a class of "dead weight": a second Redis client (`redis`/
 * node-redis) used by exactly one adapter, a zero-callsite `moment`
 * dependency, two 0-byte web build configs, a referenced-nowhere duplicate
 * `docker-compose.prod.yml`, Storybook "ghost" scripts (scripts whose
 * `storybook` binary was never installed), and a vestigial
 * `CqrsModule.forRoot()` in event-store-service that nothing consumed.
 *
 * Deleting those once is necessary but not sufficient — the architectural
 * requirement (CLAUDE.md: prefer make-it-impossible over document-it) is that
 * the SAME class of rot cannot silently grow back. This spec is the structural
 * gate. It is intentionally a Tier-1 invariant (build/test-time impossibility),
 * not a Tier-4 comment.
 *
 * # What this spec enforces
 *
 *   (a) BANNED dependencies (`redis`, `moment`) appear in NO workspace
 *       package.json — re-adding either is a red PR. The platform's single
 *       Redis client is ioredis (Socket.IO pub/sub uses an ioredis pair via
 *       @socket.io/redis-adapter); date-fns replaces moment.
 *
 *   (b) Every package.json `scripts` entry's leading CLI binary resolves —
 *       it is either a system/runtime command (node, npm, bash, docker…) or
 *       an actually-installed `node_modules/.bin` binary. This is the GENERAL
 *       solution to Storybook-class rot: a script that invokes a binary which
 *       was never installed (e.g. `"storybook": "storybook dev -p 6006"` with
 *       no storybook dependency) is dead the moment it is written and rots
 *       silently. Here it becomes a red PR.
 *
 *   (c) No 0-byte JS/TS module lives under `web/` — an empty `*.config.js` /
 *       source file is always rot (the dead Module-Federation + webpack
 *       configs A4 removed were exactly this).
 *
 *   (d) Exactly ONE `docker-compose.prod.yml` exists in the repo, at the root.
 *       The `infrastructure/docker/` copy was referenced nowhere and drifted
 *       from the canonical root file; a second copy is how that drift returns.
 *
 *   (e) `@nestjs/cqrs` importers are FROZEN to the known dirty set. The
 *       platform has two CQRS libraries (@nestjs/cqrs and @platform/cqrs); the
 *       "dead dependency" finding was REFUTED (216 files import @nestjs/cqrs
 *       across hr/messaging/billing/admin/config), so it cannot be removed
 *       here. What A4 CAN do is stop the bifurcation SPREADING: the set of
 *       services importing @nestjs/cqrs must equal the documented dirty set
 *       EXACTLY. A clean service adopting it (or event-store re-adding it) is a
 *       red PR; a dirty service finishing its migration to @platform/cqrs
 *       FORCES shrinking this allowlist (so the gate tightens over time, never
 *       loosens). The owner'd consolidation of the 216 files is tracked
 *       separately (a program, not a cleanup).
 *
 * SSoT: this file is the SSoT for the banned-dependency list and the CQRS
 * dirty-set. There is no second list to drift from.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Directories never walked: build output, VCS internals, installed deps, and
// nested agent worktree collections (full repo copies that would double-count).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.nx', 'tmp']);

function isAgentWorktreeCollectionDir(parentAbs: string, name: string): boolean {
  const rel = relative(REPO_ROOT, join(parentAbs, name));
  return rel === '.claude/worktrees' || rel === '.codex-worktrees' || rel === '.worktrees';
}

function walk(dirAbs: string, onFile: (fileAbs: string) => void): void {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (isAgentWorktreeCollectionDir(dirAbs, entry.name)) continue;
      walk(childAbs, onFile);
    } else if (entry.isFile()) {
      onFile(childAbs);
    }
  }
}

function findFiles(predicate: (fileAbs: string) => boolean): string[] {
  const out: string[] = [];
  walk(REPO_ROOT, (f) => {
    if (predicate(f)) out.push(f);
  });
  return out;
}

interface PackageJson {
  path: string;
  rel: string;
  json: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function loadPackageJsons(): PackageJson[] {
  return findFiles((f) => f.endsWith('package.json')).map((path) => ({
    path,
    rel: relative(REPO_ROOT, path),
    json: JSON.parse(readFileSync(path, 'utf8')),
  }));
}

const DEP_BLOCKS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

describe('repo hygiene invariants (A4 dead-weight)', () => {
  const packages = loadPackageJsons();

  it('finds a non-trivial set of workspace package.json files (sanity)', () => {
    // Guards against a broken walker silently asserting nothing.
    expect(packages.length).toBeGreaterThan(10);
  });

  // (a) Banned dependencies appear nowhere.
  describe('(a) banned dependencies are absent from every package.json', () => {
    const BANNED: Record<string, string> = {
      redis:
        'node-redis was removed in A4. Use ioredis (the platform single Redis client); Socket.IO pub/sub uses an ioredis pair via @socket.io/redis-adapter.',
      moment: 'moment was removed in A4 (maintenance-mode, non-tree-shakeable). Use date-fns.',
      nats: 'nats v2 was removed in A3 PR-C — the platform runs on @nats-io/* v3 (event bus, direct clients, and the NatsV3Server/NatsV3Client Nest transport). Use @nats-io/transport-node + @nats-io/nats-core.',
    };

    for (const banned of Object.keys(BANNED)) {
      it(`no package.json declares "${banned}"`, () => {
        const offenders: string[] = [];
        for (const pkg of packages) {
          for (const block of DEP_BLOCKS) {
            const deps = pkg.json[block];
            if (deps && Object.prototype.hasOwnProperty.call(deps, banned)) {
              offenders.push(`${pkg.rel} (${block})`);
            }
          }
        }
        expect(offenders).toEqual([]);
        // If this fails, remove the dependency: ${BANNED[banned]}
      });
    }

    // (a.2) Source-import scan: catches a banned package imported in a SOURCE file of
    // ANY extension that the package.json scan above + the eslint .ts-only glob miss —
    // e.g. a build script statically importing nats v2. PR-C closes exactly this gap
    // (scripts/nats/messaging-acl-smoke.mjs imported `from 'nats'` and was invisible to
    // both the package.json check and the .ts/.tsx-scoped eslint ban).
    it('no source file imports the banned "nats" v2 package', () => {
      const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
      const offenders: string[] = [];
      for (const file of findFiles((f) => SOURCE_EXT.test(f) && !f.endsWith('.d.ts'))) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const trimmed = line.trimStart();
          // Skip comment lines so JSDoc prose mentioning require('nats') is ignored.
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            continue;
          }
          // Match real import forms only — `from 'nats'` (ES import) and `import('nats')`
          // (dynamic). Exact 'nats', never '@nats-io/...'. Deliberately NOT matching
          // `require('nats')`, which appears as prose inside ban-message string literals
          // (this file + eslint.config.mjs); our code imports via ESM, and the
          // package.json banned-dep check covers a re-added dependency either way.
          if (/\bfrom\s+['"]nats['"]|\bimport\s*\(\s*['"]nats['"]/.test(line)) {
            offenders.push(relative(REPO_ROOT, file));
            break;
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // (b) Every script's leading binary resolves.
  describe('(b) every package.json script invokes a resolvable binary', () => {
    // System / runtime commands a script may invoke that are NOT installed in
    // node_modules/.bin. Anything outside this set AND outside node_modules/.bin
    // is treated as rot (e.g. an uninstalled `storybook`).
    const SYSTEM_COMMANDS = new Set([
      'node',
      'npm',
      'npx',
      'npm-run-all',
      'yarn',
      'pnpm',
      'bash',
      'sh',
      'zsh',
      'cd',
      'echo',
      'printf',
      'rm',
      'cp',
      'mv',
      'mkdir',
      'touch',
      'chmod',
      'cat',
      'env',
      'git',
      'docker',
      'python',
      'python3',
      'set',
      'export',
      'source',
      'wait',
      'kill',
      'sleep',
      'test',
      'true',
      'false',
      'exit',
      'cross-env',
      'cross-env-shell',
      'wait-on',
    ]);

    const binDir = join(REPO_ROOT, 'node_modules', '.bin');
    const installedBins = existsSync(binDir) ? new Set(readdirSync(binDir)) : new Set<string>();

    it('node_modules/.bin is populated (precondition)', () => {
      // The resolution check is only meaningful after install. In CI the
      // invariant suite runs post-`npm ci`, so .bin is always present.
      expect(installedBins.size).toBeGreaterThan(0);
    });

    /**
     * Extract the leading binary token of each `&&`-sequenced segment of a
     * script command. We deliberately split ONLY on `&&` — never on `|`, `;`
     * or `||` — because those commonly appear INSIDE quoted inline code
     * (e.g. `python3 -c "...a | b..."`) and splitting on them mis-tokenises
     * the quoted body. A non-leading rot is rare; a false positive from a
     * mis-split quote would make this gate brittle, which is worse.
     */
    function leadingBinaries(command: string): string[] {
      const tokens: string[] = [];
      for (const segment of command.split('&&')) {
        const words = segment
          .trim()
          .split(/\s+/)
          // Drop leading `ENV=value` assignments (e.g. PYTHONPATH=., NODE_ENV=x).
          .filter((w) => !/^[A-Za-z0-9_]+=/.test(w));
        const tok = words[0];
        if (!tok) continue;
        // Skip flags, paths, shell vars, subshells, and quoted/escaped forms —
        // these are not bare binary names we can resolve by name.
        if (/^[-/.]/.test(tok)) continue;
        if (/["'`$(){}\\]/.test(tok)) continue;
        tokens.push(tok);
      }
      return tokens;
    }

    it('no script invokes an uninstalled binary (Storybook-class rot)', () => {
      const offenders: string[] = [];
      for (const pkg of packages) {
        const scripts = pkg.json.scripts ?? {};
        for (const [name, command] of Object.entries(scripts)) {
          for (const bin of leadingBinaries(command)) {
            if (SYSTEM_COMMANDS.has(bin)) continue;
            if (installedBins.has(bin)) continue;
            offenders.push(`${pkg.rel} :: "${name}" -> ${bin} (not in node_modules/.bin)`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // (c) No 0-byte JS/TS module under web/.
  it('(c) no 0-byte JS/TS module exists under web/', () => {
    const webRoot = join(REPO_ROOT, 'web');
    const empties: string[] = [];
    if (existsSync(webRoot)) {
      walk(webRoot, (f) => {
        if (/\.(c|m)?[jt]sx?$/.test(f) && statSync(f).size === 0) {
          empties.push(relative(REPO_ROOT, f));
        }
      });
    }
    expect(empties).toEqual([]);
  });

  // (d) Exactly one docker-compose.prod.yml, at the repo root.
  it('(d) exactly one docker-compose.prod.yml exists, at the repo root', () => {
    const composes = findFiles((f) => f.endsWith('docker-compose.prod.yml')).map((f) =>
      relative(REPO_ROOT, f),
    );
    expect(composes).toEqual(['docker-compose.prod.yml']);
  });

  // (e) @nestjs/cqrs bifurcation freeze.
  describe('(e) @nestjs/cqrs importers are frozen to the dirty set', () => {
    // Services that legitimately still import @nestjs/cqrs. This set may only
    // SHRINK (as services migrate to @platform/cqrs), never grow. event-store
    // dropped out in A4 (its CqrsModule.forRoot() was vestigial and removed).
    const DIRTY_CQRS_SERVICES = [
      'admin-api-service',
      'billing-service',
      'config-service',
      'hr-service',
      'messaging-service',
    ].sort();

    function servicesImportingNestCqrs(): string[] {
      const appsRoot = join(REPO_ROOT, 'apps');
      const hits = new Set<string>();
      if (!existsSync(appsRoot)) return [];
      for (const svc of readdirSync(appsRoot, { withFileTypes: true })) {
        if (!svc.isDirectory()) continue;
        const srcRoot = join(appsRoot, svc.name, 'src');
        if (!existsSync(srcRoot)) continue;
        walk(srcRoot, (f) => {
          if (!/\.tsx?$/.test(f)) return;
          // Test files are excluded because a spec that ASSERTS THE ABSENCE of
          // this import necessarily contains the literal it forbids. The suffix
          // set must stay wide: `*.e2e-spec.ts` does not end in `.spec.ts`, and
          // that one-character gap is exactly how farm-service's P0 security
          // spec started registering as a @nestjs/cqrs importer.
          if (/[.-](spec|test)\.tsx?$/.test(f)) return;
          const text = readFileSync(f, 'utf8');
          if (/from\s+['"]@nestjs\/cqrs['"]/.test(text)) hits.add(svc.name);
        });
      }
      return [...hits].sort();
    }

    it('the set of @nestjs/cqrs-importing services equals the documented dirty set EXACTLY', () => {
      // Exact equality both ways:
      //  - a NEW importer (clean service or re-added event-store) => red PR.
      //  - a service that finished migrating => this list MUST be trimmed,
      //    so the freeze ratchets down and never goes stale.
      expect(servicesImportingNestCqrs()).toEqual(DIRTY_CQRS_SERVICES);
    });
  });
});
