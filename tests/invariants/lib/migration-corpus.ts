/**
 * The migration set a service ACTUALLY APPLIES — the single answer to a question
 * eight invariants were each answering for themselves, four of them wrongly.
 *
 * # The defect this exists to remove
 *
 * On 2026-05-18 four services squashed their migrations into a `Baseline` and
 * moved the originals to `src/…/migrations/.archive/<timestamp>/`. The archive is
 * dead by construction: every service's TypeORM entry declares
 * `migrations: ['src/…/migrations/[0-9]*…']`, a pattern that neither matches a
 * dot-directory nor descends into one. Fifty-five files stopped running.
 *
 * Invariants that read migrations did not all notice. The idiom
 *
 *     git ls-files 'apps/<svc>/src/migrations/*.ts'
 *
 * looks scoped to one directory and is not: a git pathspec `*` crosses `/`, so
 * it returns the archive too — 32 files for auth-service, 13 of them dead. So
 * `auth-users-tenant-fk.spec.ts` asserted that a FOREIGN KEY exists, PASSED, and
 * was reading an archived migration. The constraint it guards is absent from
 * every migration the runtime applies, and so is `shared.access_logs`, which
 * four other layers still declare and request middleware still writes to.
 * ORPHAN-CRITICAL-516.
 *
 * A gate reporting green off evidence the runtime never executes is worse than
 * no gate: it is a standing claim that something is protected when it is not.
 *
 * # Why a shared module rather than a fix in each spec
 *
 * Four of the eight migration-reading specs already guard against the archive,
 * each in its own way, and `audit-immutability-triggers.spec.ts` even has a
 * private function called `loadMigrationCorpus`. The right pattern was in the
 * repository and half the callers did not use it — the ORPHAN-HIGH-499 shape.
 * Eight private answers to one question is how four of them drift.
 *
 * # Why the directory is DERIVED
 *
 * Services disagree about where migrations live (`src/migrations` for auth,
 * admin, event-store, messaging; `src/database/migrations` for the other ten)
 * and about the glob's suffix spelling. Hardcoding either would put this
 * module's notion of "effective" and the runtime's in two places, which is the
 * defect one layer up. `data-source.ts` is the per-service TypeORM entry point
 * CLAUDE.md names as the migration SSoT, and it declares the pattern uniformly,
 * so that is what is read.
 *
 * # What this module does NOT own
 *
 * Whether a service's runtime array actually REGISTERS every file on disk —
 * farm-service uses an explicit array rather than a glob, and
 * `migration-registration-completeness.spec.ts` owns that question. This module
 * answers only "what is on disk and not retired", which is the input that spec
 * and the seven others need.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** `migrations: ['src/<something>/[0-9]*…']` in a service's TypeORM entry. */
const MIGRATIONS_GLOB = /migrations:\s*\[\s*'(src\/[A-Za-z0-9_/-]*migrations)\/\[0-9\]\*/;

export interface MigrationCorpus {
  /** Service directory name, e.g. `auth-service`. */
  readonly service: string;
  /** Repo-relative migrations directory, derived from the service's own entry. */
  readonly directory: string;
  /** Repo-relative paths of the migrations the runtime applies, sorted. */
  readonly files: readonly string[];
  /** Repo-relative paths of migrations the runtime no longer applies. */
  readonly archived: readonly string[];
  /** Concatenated source of the effective set — what a fresh database gets. */
  readonly source: string;
}

function gitFiles(pathspec: string): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', pathspec], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * The migrations directory `service` declares, read from its TypeORM entry.
 *
 * Refuses rather than guessing. A service whose entry this cannot parse would
 * otherwise be modelled against the wrong directory — reporting files it does
 * not run, or omitting files it does — which is exactly the error class this
 * module exists to remove.
 */
function migrationsDirectory(service: string): string {
  const candidates = [
    `apps/${service}/src/database/data-source.ts`,
    `apps/${service}/src/data-source.ts`,
  ].filter((rel) => existsSync(resolve(REPO_ROOT, rel)));

  for (const rel of candidates) {
    const match = MIGRATIONS_GLOB.exec(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
    if (match?.[1]) return `apps/${service}/${match[1]}`;
  }
  throw new Error(
    `migration-corpus: cannot derive the migrations directory for ${service}. ` +
      `Looked for a \`migrations: ['src/…/[0-9]*…']\` glob in ` +
      `${candidates.join(', ') || '(no data-source.ts found)'}. This module refuses ` +
      'to guess: a wrong directory would silently change which migrations count ' +
      'as effective, which is the defect it exists to prevent.',
  );
}

/**
 * True when `rel` is a migration the runtime applies.
 *
 * Mirrors `[0-9]*` exactly: the file sits DIRECTLY in the declared directory and
 * its name begins with a digit. A file under `.archive/` fails the first clause,
 * which is precisely why it is dead — and why a `git ls-files` pathspec, whose
 * `*` crosses `/`, is the wrong instrument for this question.
 */
function isEffective(rel: string, directory: string): boolean {
  if (dirname(rel) !== directory) return false;
  const name = basename(rel);
  return /^[0-9]/.test(name) && (name.endsWith('.ts') || name.endsWith('.js'));
}

const cache = new Map<string, MigrationCorpus>();

/** The migrations `service` applies, and the ones it has retired. */
export function migrationCorpus(service: string): MigrationCorpus {
  const cached = cache.get(service);
  if (cached) return cached;

  const directory = migrationsDirectory(service);

  // Deliberately the archive-matching pathspec, so the split is COMPUTED here
  // rather than assumed. Asking git for only the effective files would make the
  // `archived` list unknowable, and that list is what proves the split is real.
  const all = gitFiles(`${directory}/*.ts`);
  const files = all.filter((rel) => isEffective(rel, directory)).sort();
  const archived = all.filter((rel) => !isEffective(rel, directory)).sort();

  if (files.length === 0) {
    throw new Error(
      `migration-corpus: ${service} has no effective migrations under ${directory}. ` +
        'Either the service name is wrong or every migration has been archived, ' +
        'and a spec asserting over an empty corpus would pass vacuously.',
    );
  }

  const corpus: MigrationCorpus = {
    service,
    directory,
    files,
    archived,
    source: files
      .map((rel) => `-- ${rel}\n${readFileSync(resolve(REPO_ROOT, rel), 'utf8')}`)
      .join('\n'),
  };
  cache.set(service, corpus);
  return corpus;
}

/** The concatenated effective source of several services, in the order given. */
export function migrationSource(...services: readonly string[]): string {
  return services.map((service) => migrationCorpus(service).source).join('\n---\n');
}

/** Every service that owns a migrations directory. */
export function servicesWithMigrations(): string[] {
  const services = new Set<string>();
  for (const rel of gitFiles('apps/*/src/**/migrations/*.ts')) {
    const service = rel.split('/')[1];
    if (service) services.add(service);
  }
  return [...services].sort();
}
