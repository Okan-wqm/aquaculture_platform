/**
 * INVARIANT — no dead guards (ADR-0010, SEC-HIGH-060).
 *
 * `IpWhitelistGuard` sat in gateway-api for two years registered in no
 * module, under no `APP_GUARD`, in no `@UseGuards()`. It read as an access
 * control and controlled nothing. A guard class that exists but is wired to
 * no request path is worse than no guard: reviewers, auditors and the next
 * engineer all read it as protection.
 *
 * Rule: every non-abstract class implementing `CanActivate` under `apps/**`
 * and `libs/**` (production source, not tests) must be reachable from a
 * registration site:
 *   - an `APP_GUARD` provider (`useClass`, `useExisting`, or a `useFactory`
 *     that constructs it),
 *   - a `@UseGuards(...)` / `UseGuards(...)` call (controller, resolver,
 *     handler, or an `applyDecorators` bundle),
 *   - a `globalGuards: [...]` / `useGlobalGuards(...)` bootstrap list,
 *   - or a registered guard that `extends` it,
 * or carry an entry in `.claude/allowlists/unregistered-guards.yaml` with
 * `{owner, expiry, findingId, reason}`. Expired entries fail; entries whose
 * class no longer exists fail (the list only shrinks).
 *
 * The second block keeps both retired IP access-rule stacks deleted.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ALLOWLIST = resolve(REPO_ROOT, '.claude/allowlists/unregistered-guards.yaml');

/** Production source only: tests, fixtures and built output are not registration evidence. */
const NOT_PRODUCTION =
  /(^|\/)(__tests__|__mocks__|test|tests|e2e|dist|\.archive)\/|\.(spec|test)\.tsx?$/;

function listSourceFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'apps',
      'libs',
      'platform',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !NOT_PRODUCTION.test(path));
}

/** Drop block + line comments so docstrings do not register as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<![:'"`])\/\/.*$/, ''))
    .join('\n');
}

interface GuardDefinition {
  className: string;
  file: string;
  /** Direct superclass identifier, when the declaration has one. */
  extendsClass: string | null;
}

const CLASS_DECL = /\bclass\s+([A-Za-z_$][\w$]*)\s*([^{]*)\{/g;

/** Non-abstract classes whose declaration lists `CanActivate` among its interfaces. */
function guardDefinitions(file: string, src: string): GuardDefinition[] {
  const found: GuardDefinition[] = [];
  for (const match of src.matchAll(CLASS_DECL)) {
    const whole = match[0];
    const className = match[1] ?? '';
    const heritage = match[2] ?? '';
    const declStart = src.lastIndexOf('\n', match.index ?? 0) + 1;
    const preamble = src.slice(declStart, (match.index ?? 0) + whole.length);
    if (/\babstract\s+class\b/.test(preamble)) continue;
    if (!/\bimplements\b[^{]*\bCanActivate\b/.test(heritage)) continue;
    const ext = /\bextends\s+([A-Za-z_$][\w$]*)/.exec(heritage);
    found.push({ className, file, extendsClass: ext?.[1] ?? null });
  }
  return found;
}

const IDENT = /[A-Za-z_$][\w$]*/g;

/** Identifiers inside one balanced `(` … `)` group starting at `open`. */
function balancedGroup(src: string, open: number, openCh: string, closeCh: string): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** The object literal enclosing `at`: walk back to its `{`, forward to the matching `}`. */
function enclosingObject(src: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return '';
  return balancedGroup(src, start, '{', '}');
}

/** Every class identifier a file wires as a guard, by any registration form. */
function registrationSites(src: string): Set<string> {
  const names = new Set<string>();
  const add = (text: string): void => {
    for (const id of text.match(IDENT) ?? []) names.add(id);
  };

  for (const match of src.matchAll(/\bUseGuards\s*\(/g)) {
    add(balancedGroup(src, (match.index ?? 0) + match[0].length - 1, '(', ')'));
  }
  for (const match of src.matchAll(/\buseGlobalGuards\s*\(/g)) {
    add(balancedGroup(src, (match.index ?? 0) + match[0].length - 1, '(', ')'));
  }
  for (const match of src.matchAll(/\bglobalGuards\s*:\s*\[/g)) {
    add(balancedGroup(src, (match.index ?? 0) + match[0].length - 1, '[', ']'));
  }
  for (const match of src.matchAll(/\bprovide\s*:\s*APP_GUARD\b/g)) {
    const provider = enclosingObject(src, match.index ?? 0);
    for (const bound of provider.matchAll(/\b(?:useClass|useExisting)\s*:\s*([A-Za-z_$][\w$]*)/g)) {
      names.add(bound[1] ?? '');
    }
    for (const constructed of provider.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(constructed[1] ?? '');
    }
  }
  return names;
}

interface AllowlistEntry {
  class: string;
  file: string;
  owner: string;
  /** js-yaml parses an unquoted YYYY-MM-DD as a Date; both forms are accepted. */
  expiry: string | Date;
  findingId: string;
  reason: string;
}

function allowlist(): AllowlistEntry[] {
  const doc = yaml.load(readFileSync(ALLOWLIST, 'utf8')) as { entries?: AllowlistEntry[] };
  return doc.entries ?? [];
}

function expiryDate(entry: AllowlistEntry): string {
  return entry.expiry instanceof Date
    ? entry.expiry.toISOString().slice(0, 10)
    : String(entry.expiry);
}

function governanceProblems(entry: AllowlistEntry, today: string): string[] {
  const label = `${entry.class} (${entry.file})`;
  const problems: string[] = [];
  for (const key of ['class', 'file', 'owner', 'findingId', 'reason'] as const) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '')
      problems.push(`${label}: missing ${key}`);
  }
  const expiry = expiryDate(entry);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) problems.push(`${label}: expiry is not YYYY-MM-DD`);
  else if (expiry <= today) problems.push(`${label}: expired on ${expiry}`);
  return problems;
}

/** Guards reachable from a registration site, closed over `extends`. */
function reachableGuards(definitions: GuardDefinition[], registered: Set<string>): Set<string> {
  const byName = new Map(definitions.map((d) => [d.className, d]));
  const reachable = new Set<string>();
  const queue = [...registered];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const definition = byName.get(name);
    if (definition?.extendsClass) queue.push(definition.extendsClass);
  }
  return reachable;
}

describe('INVARIANT: no dead guards — every CanActivate is wired to a request path or governed (ADR-0010)', () => {
  const files = listSourceFiles();
  const sources = new Map(
    files.map((file) => [file, stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'))]),
  );
  const definitions = [...sources.entries()].flatMap(([file, src]) => guardDefinitions(file, src));
  const registered = new Set<string>();
  for (const src of sources.values()) {
    for (const name of registrationSites(src)) registered.add(name);
  }
  const reachable = reachableGuards(definitions, registered);
  const today = new Date().toISOString().slice(0, 10);

  it('finds the fleet guard inventory (sanity: the scan is not silently empty)', () => {
    expect(definitions.length).toBeGreaterThan(10);
    expect(registered.size).toBeGreaterThan(10);
  });

  it('every allowlist entry is governed (owner, expiry, finding, reason) and names a guard that still exists', () => {
    const entries = allowlist();
    const problems = entries.flatMap((entry) => governanceProblems(entry, today));
    const known = new Set(definitions.map((d) => `${d.className}@${d.file}`));
    for (const entry of entries) {
      if (!known.has(`${entry.class}@${entry.file}`)) {
        problems.push(
          `${entry.class} (${entry.file}): no such CanActivate class — delete the entry`,
        );
      }
      if (reachable.has(entry.class)) {
        problems.push(
          `${entry.class} (${entry.file}): is registered — delete the entry, the guard is live`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('no CanActivate class in apps/** or libs/** is unregistered and ungoverned', () => {
    const tolerated = new Set(allowlist().map((entry) => `${entry.class}@${entry.file}`));
    const dead = definitions
      .filter((d) => !reachable.has(d.className))
      .filter((d) => !tolerated.has(`${d.className}@${d.file}`))
      .map((d) => `${d.className} (${d.file})`)
      .sort();
    expect(dead).toEqual([]);
  });
});

describe('INVARIANT: both IP access-rule stacks stay deleted (ADR-0010)', () => {
  /** Identifiers that named the deleted stacks; a list of things that must stay gone. */
  const RETIRED_IDENTIFIERS: ReadonlyArray<string> = [
    'IpWhitelistGuard',
    'BypassIpWhitelist',
    'IP_WHITELIST_ENABLED',
    'ip_access_rules',
    'IpAccessRule',
    'IpAccessController',
    'IpAccessService',
    'settings/ip-access',
    'IpAccessRulesPage',
  ];
  const SEARCH_ROOTS: ReadonlyArray<string> = [
    'apps',
    'libs',
    'platform',
    'web',
    'tests',
    'e2e',
    'infrastructure',
    'scripts',
    'tools',
    '.claude/allowlists',
    'docker-compose.droplet.yml',
    'docker-compose.staging.yml',
  ];
  const HISTORICAL_PATH = /(^|\/)(migrations|\.archive|dist)\//;

  function gitGrepFiles(patterns: ReadonlyArray<string>): string[] {
    try {
      return execFileSync(
        'git',
        [
          '-C',
          REPO_ROOT,
          'grep',
          '-l',
          '-F',
          '--untracked',
          ...patterns.flatMap((p) => ['-e', p]),
          '--',
          ...SEARCH_ROOTS,
        ],
        { encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 1) return [];
      throw err;
    }
  }

  it('no live source, test, config or deploy artefact names a retired IP access-rule identifier', () => {
    const offenders = gitGrepFiles(RETIRED_IDENTIFIERS)
      .filter((path) => !HISTORICAL_PATH.test(path))
      .filter((path) => path !== 'tests/invariants/no-dead-guards.spec.ts')
      // Baseline ledger whose notes narrate past cleanups; history, not code.
      .filter((path) => path !== 'tools/gates/type-check-spec-baseline.json')
      // Formatter scope manifest is regenerated from git; stale rows are not code.
      .filter((path) => path !== 'tools/quality/format-scope.json');
    expect(offenders).toEqual([]);
  });

  it('the retirement migration archives the rules before dropping the table', () => {
    const migration = readFileSync(
      resolve(
        REPO_ROOT,
        'apps/admin-api-service/src/migrations/1808800000000-RetireIpAccessRules.ts',
      ),
      'utf8',
    );
    expect(migration).toMatch(
      /SELECT 'ip_access_rules', to_jsonb\(t\) FROM "admin"\."ip_access_rules" t/,
    );
    expect(migration).toMatch(/DROP TABLE IF EXISTS "admin"\."ip_access_rules"/);
  });
});
