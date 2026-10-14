/**
 * INVARIANT (ORPHAN-CRITICAL-516): a migration invariant reads the migrations
 * the runtime applies, never the retired ones.
 *
 * The 2026-05-18 squash moved 55 migrations into `src/…/migrations/.archive/`,
 * which no service's `[0-9]*` migrations glob selects. Two guards kept reading
 * that directory. A git pathspec `*` crosses `/`, so
 * `auth-users-tenant-fk.spec.ts` stayed green on `FK_auth_users_tenantId` while
 * the only migration declaring it was archived, and nothing noticed that
 * `shared.access_logs` was no longer created. The DDL came back as forward-only
 * restorations, and the migration specs now read `lib/migration-corpus.ts`.
 *
 * Those specs prove the DDL is in the corpus. Nothing proved the corpus is the
 * runtime's set. The retired originals are still in `.archive/`, so a corpus
 * that admitted them would make both guards report a false green again as soon
 * as a restoration went missing. This spec checks the corpus against git's
 * glob magic, an independent reading of the same `<dir>/[0-9]*.ts` glob (`*`
 * stops at `/`, as it does for TypeORM).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { migrationCorpus, servicesWithMigrations } from './lib/migration-corpus';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** `<directory>/[0-9]*.ts` read by git's glob magic, where `*` never crosses `/`. */
function runtimeGlob(directory: string): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', `:(glob)${directory}/[0-9]*.ts`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();
}

/** The two originals whose archived DDL the false green was read from. */
const RETIRED_ORIGINALS = [
  {
    service: 'auth-service',
    file: '1787200000000-AddAuthUsersTenantFk.ts',
    className: 'AddAuthUsersTenantFk1787200000000',
  },
  {
    service: 'admin-api-service',
    file: '1788400000000-CreateSharedAccessLogs.ts',
    className: 'CreateSharedAccessLogs1788400000000',
  },
] as const;

describe('INVARIANT (ORPHAN-CRITICAL-516): the migration corpus is the set the runtime applies', () => {
  const services = servicesWithMigrations();

  it('finds the services whose retired migrations caused the finding', () => {
    // An empty or partial service list would make the per-service check below
    // pass on nothing.
    for (const { service } of RETIRED_ORIGINALS) {
      expect(services).toContain(service);
    }
  });

  it.each(services)('%s: the corpus is exactly its migrations glob', (service) => {
    const corpus = migrationCorpus(service);
    expect(corpus.files).toEqual(runtimeGlob(corpus.directory));
    expect(corpus.files.filter((rel) => rel.includes('/.archive/'))).toEqual([]);
  });

  it.each(RETIRED_ORIGINALS)(
    '$service: the archived $file is retired, never evidence',
    ({ service, file, className }) => {
      const corpus = migrationCorpus(service);
      // The archive is real: the split is computed over the retired file, not
      // assumed because it is absent.
      expect(
        corpus.archived.some((rel) => rel.includes('/.archive/') && rel.endsWith(`/${file}`)),
      ).toBe(true);
      expect(corpus.files.some((rel) => rel.endsWith(`/${file}`))).toBe(false);
      // A restoration may name the original in its comment; only the class
      // itself would make the archived DDL count as applied.
      expect(corpus.source).not.toContain(`export class ${className}`);
    },
  );
});
