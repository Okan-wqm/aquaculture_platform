/**
 * INVARIANT: tenant configuration has ONE author, and the retired REST surface
 * cannot come back.
 *
 * # What went wrong, precisely
 *
 * `admin.tenant_configurations` was dropped by admin-api migration
 * 1801400000000 on the strength of a docblock — "config-service owns tenant
 * configuration now". Nothing implemented that. config-service resolved tenant
 * scope exclusively from the caller's JWT, and SUPER_ADMIN is the platform's
 * only tenantless principal, so no operation could address another tenant's
 * partition; no tenant-config key had ever been defined, let alone seeded.
 *
 * The claim was structurally unfalsifiable. It lived in a comment, the panel
 * kept compiling against its own hand-written mirror of a shape nothing served,
 * and admin-api's read paths synthesized `createDefaultTenantConfiguration()` —
 * so a page over a dropped table still rendered a full form. Every write threw
 * 410 Gone and the operator's only clue was the error toast.
 *
 * # What this pins
 *
 * 1. The vocabulary is the single author: the seed migration DERIVES its rows
 *    from it rather than restating them, and the panel's copy is generated from
 *    the same file rather than typed out.
 * 2. The retired REST client is gone and cannot return — no admin-panel module
 *    may reference `/settings/tenant/`, and admin-api may not declare a
 *    tenant-configuration controller or service again.
 * 3. `enforcedBy` is honest: a setting the platform stores but no runtime reads
 *    is recorded as such, and the count of those can only fall.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const VOCABULARY_PATH =
  'apps/config-service/src/configuration/tenant-settings/tenant-settings.vocabulary.ts';
const SEED_MIGRATION_PATH =
  'apps/config-service/src/database/migrations/1805500000000-SeedTenantSettingsDefaults.ts';
const GENERATED_CONTRACTS_PATH =
  'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function trackedFiles(pathspec: string): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', pathspec], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((rel) => rel.length > 0);
}

/** Every `key:` literal declared in the vocabulary, in declaration order. */
function vocabularyKeys(): string[] {
  const source = read(VOCABULARY_PATH);
  const body = /export const TENANT_SETTINGS = \[([\s\S]*?)\n\] as const/.exec(source)?.[1];
  if (body == null) throw new Error('TENANT_SETTINGS array not found in the vocabulary');
  return [...body.matchAll(/^\s*key: '([^']+)',$/gm)].map((match) => match[1]!);
}

/** Every `enforcedBy:` value in the vocabulary, in declaration order. */
function enforcedByValues(): string[] {
  const source = read(VOCABULARY_PATH);
  const body = /export const TENANT_SETTINGS = \[([\s\S]*?)\n\] as const/.exec(source)?.[1];
  if (body == null) throw new Error('TENANT_SETTINGS array not found in the vocabulary');
  return [...body.matchAll(/^\s*enforcedBy: (null|'[^']*'),$/gm)].map((match) => match[1]!);
}

describe('INVARIANT: tenant settings have one author', () => {
  it('finds a non-trivial vocabulary', () => {
    // Guards every assertion below against a regex that quietly matched nothing.
    expect(vocabularyKeys().length).toBeGreaterThan(50);
  });

  it('the seed migration DERIVES its rows from the vocabulary', () => {
    const migration = read(SEED_MIGRATION_PATH);

    expect(migration).toContain('TENANT_SETTINGS');
    expect(migration).toMatch(/for \(const setting of TENANT_SETTINGS\)/);

    // A restated key would be a second author, which is how the seeded key set
    // and the edited key set drift into disagreement.
    for (const key of vocabularyKeys()) {
      expect(migration).not.toContain(`'${key}'`);
    }
  });

  it('the admin panel GENERATES its copy rather than declaring one', () => {
    const generated = read(GENERATED_CONTRACTS_PATH);
    expect(generated).toContain('export const TENANT_SETTINGS = [');
    expect(generated).toContain('export const TENANT_SETTINGS_SERVICE = "tenant-settings"');

    // Same keys, same order — the generated file is a projection of the
    // vocabulary, not an independent list that happens to agree today.
    const generatedKeys = [...generated.matchAll(/\{ key: "([^"]+)", section: "/g)].map(
      (match) => match[1]!,
    );
    expect(generatedKeys).toEqual(vocabularyKeys());
  });

  it('the panel names no tenant setting key in source at all', () => {
    // The whole tenant-configuration surface walks the generated vocabulary: the
    // data layer indexes it, the page renders a field per entry. A literal key
    // anywhere in those modules is a hard-coded exception to that — the one a
    // rename leaves behind, silently rendering a field the store no longer has.
    //
    // Note this is NOT a check that literals resolve to real keys. Several
    // prefixes (`security.`, `storage.`, `api.`) exist in the platform
    // vocabulary too, so "is this a valid key" is ambiguous by prefix; "does
    // this module quote a key at all" is not.
    const vocabulary = new Set(vocabularyKeys());
    const offenders: string[] = [];

    for (const rel of [
      'web/modules/admin-panel/src/services/api/tenant-configuration.ts',
      'web/modules/admin-panel/src/hooks/useTenantConfiguration.ts',
      'web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx',
    ]) {
      const source = read(rel);
      for (const match of source.matchAll(/['"]([a-z_]+\.[a-z0-9_.]+)['"]/g)) {
        if (vocabulary.has(match[1]!)) offenders.push(`${rel}: ${match[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('INVARIANT: the retired tenant-configuration REST surface stays retired', () => {
  it('no admin-panel module addresses /settings/tenant/', () => {
    // 39 routes whose service threw 410 Gone on every write and synthesized
    // identical defaults on every read. A resurrected call would compile, ship,
    // and fail only in front of an operator.
    const offenders = trackedFiles('web/modules/admin-panel/src/**/*.ts*').filter((rel) =>
      read(rel).includes('/settings/tenant/'),
    );
    expect(offenders).toEqual([]);
  });

  it('admin-api declares no tenant-configuration controller, service or entity', () => {
    for (const rel of [
      'apps/admin-api-service/src/settings/controllers/tenant-configuration.controller.ts',
      'apps/admin-api-service/src/settings/services/tenant-configuration.service.ts',
      'apps/admin-api-service/src/settings/dto/tenant-configuration.dto.ts',
      'apps/admin-api-service/src/settings/entities/tenant-configuration.entity.ts',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, rel))).toBe(false);
    }
  });

  it('tenant provisioning writes no configuration', () => {
    // Defaults are seeded once under SYSTEM and answered by the effective merge,
    // so a new tenant needs zero configuration rows. The step this replaces
    // minted a requestId, logged it and returned — provisioning reported success
    // for work nobody did.
    const provisioning = read('apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts');
    expect(provisioning).not.toContain('create_default_config');
    expect(provisioning).not.toContain('TenantConfigurationService');
  });
});

describe('INVARIANT: a stored tenant setting states whether anything enforces it', () => {
  it('every declared enforcer is a real file that mentions its key', () => {
    // A path nobody checks is a claim, and a claim is what started this.
    const source = read(VOCABULARY_PATH);
    const entries = [
      ...source.matchAll(/key: '([^']+)',[\s\S]*?enforcedBy: (null|'[^']*'),/g),
    ];

    for (const [, key, enforcedBy] of entries) {
      if (enforcedBy === 'null') continue;
      const path = enforcedBy!.slice(1, -1);
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
      expect(read(path)).toContain(key!);
    }
  });

  it('the count of settings NOTHING enforces only ever falls', () => {
    // The honest half of the migration, published rather than hidden.
    //
    // Every tenant setting now persists per tenant, with history, RLS and an
    // audit trail — but persisting is not enforcing, and the surface this
    // replaced failed exactly by blurring the two. So the vocabulary records an
    // enforcer per key and this ratchet holds the number that have none. Wiring
    // one is a two-line change here plus the consumer; the number can only go
    // down.
    //
    // Tracked as ADMIN-HIGH-097 (owner by-okan@live.com, deadline 2026-10-15).
    const UNENFORCED_BUDGET = 90;

    const unenforced = enforcedByValues().filter((value) => value === 'null').length;
    expect(unenforced).toBe(UNENFORCED_BUDGET);
  });
});
