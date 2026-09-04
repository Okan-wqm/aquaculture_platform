/**
 * INVARIANT: a TypeORM `ValueTransformer` must pass `undefined` through as
 * `undefined`, so an unprovided column keeps its DEFAULT.
 *
 * # Why this exists
 *
 * TypeORM asks the transformer about EVERY column it is about to write, including
 * the ones the caller never set — `ApplyValueTransformers.transformTo` runs
 * unconditionally. What comes back decides the SQL:
 *
 *   node_modules/typeorm/query-builder/InsertQueryBuilder.js
 *     value === undefined  ->  expression += "DEFAULT"
 *     otherwise            ->  expression += this.createParameter(value)
 *
 * So a transformer that answers `null` for an unprovided value has not said
 * "nothing here"; it has said "write NULL". Every `NOT NULL DEFAULT` column it
 * guards then becomes unwritable unless the caller names it explicitly, and the
 * failure surfaces as
 *
 *     null value in column "used_capacity" of relation "storage_locations"
 *     violates not-null constraint
 *
 * with both the entity (`default: 0`) and the migration
 * (`numeric(15,2) NOT NULL DEFAULT '0'`) correct — which is what makes it read
 * as an entity/migration mismatch and cost a day. Found by
 * `feeding-record-tenant-isolation.postgres.spec.ts` the first time CI ran the
 * farm integration lane (INFRA-MEDIUM-142); `DecimalTransformer` alone is paired
 * with a `default:` on 44 column declarations across 79 entities, and
 * `@MoneyColumn({ default: 0 })` guards three more in billing.
 *
 * `null` is NOT the same answer and still passes through: clearing a nullable
 * column is a deliberate value.
 *
 * # Why the property and not the two files
 *
 * Two of seven transformers had this defect and five did not, which is exactly
 * the shape that comes back — the next transformer is written by copying
 * whichever neighbour the author opened first. So this asserts the property over
 * every transformer the ORM can reach, and fails closed on one it has not been
 * told about.
 *
 * Discovery is by USE: a transformer only affects a column by appearing as
 * `transformer:` in that column's options, so scanning for that reference finds
 * every transformer that can do damage, including one added tomorrow. Comments
 * are stripped first (a migration docblock contains the prose "…BEFORE the
 * transformer: it re-writes…"), and `__tests__` / `*.spec.ts` are excluded
 * because a `let transformer: Foo` type annotation is not a column declaration.
 * `web/` is not scanned: no TypeORM entity lives there.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { ValueTransformer } from 'typeorm';

import {
  BigIntStringTransformer,
  BigIntTransformer,
} from '../../apps/event-store-service/src/event-store/transformers/bigint.transformer';
import { EncryptedColumnTransformer } from '../../apps/sensor-service/src/infrastructure/vault/credential.transformer';
import { EncryptedProtocolConfigTransformer } from '../../apps/sensor-service/src/infrastructure/vault/protocol-config.transformer';
import { DecimalTransformer } from '../../libs/backend-common/src/database/decimal-transformer';
import { DecimalValueTransformer } from '../../libs/backend-common/src/monetary/decimal-column.decorator';
import { createEncryptedColumnTransformer } from '../../libs/backend-common/src/security/encryption/encrypted-column.transformer';

import { stripComments } from './helpers/ts-source';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCANNED_ROOTS = ['apps', 'libs', 'platform'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.archive',
  '__tests__',
  '__mocks__',
]);

interface RegisteredTransformer {
  /**
   * The identifiers a column declaration may name to install this transformer.
   * More than one where a decorator hands columns a private singleton: the
   * column's options say `DECIMAL_TRANSFORMER`, and the thing under test is the
   * class it is an instance of.
   */
  readonly aliases: readonly string[];
  /** A factory, so an entry that throws on construction fails in its own test. */
  readonly create: () => ValueTransformer;
}

/** Every transformer a column declaration in this repository can install. */
const TRANSFORMERS: readonly RegisteredTransformer[] = [
  { aliases: ['DecimalTransformer'], create: () => new DecimalTransformer() },
  {
    aliases: ['DecimalValueTransformer', 'DECIMAL_TRANSFORMER'],
    create: () => new DecimalValueTransformer(),
  },
  { aliases: ['BigIntTransformer'], create: () => new BigIntTransformer() },
  { aliases: ['BigIntStringTransformer'], create: () => new BigIntStringTransformer() },
  { aliases: ['EncryptedColumnTransformer'], create: () => EncryptedColumnTransformer },
  {
    aliases: ['EncryptedProtocolConfigTransformer'],
    create: () => EncryptedProtocolConfigTransformer,
  },
  {
    aliases: ['createEncryptedColumnTransformer'],
    // Both nullish branches short-circuit before the key is resolved, so the
    // probe name never has to name a real env var.
    create: () => createEncryptedColumnTransformer('INVARIANT_PROBE_ENCRYPTION_KEY'),
  },
];

const REGISTERED_ALIASES = new Set(TRANSFORMERS.flatMap((entry) => entry.aliases));

const TRANSFORMER_REFERENCE = /\btransformer:\s*(?:new\s+)?([A-Za-z_$][\w$]*)/g;

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
      if (/\.(spec|e2e-spec|test)\.ts$/.test(entry)) continue;
      found.push(full);
    }
  };
  walk(resolve(REPO_ROOT, root));
  return found;
}

/** identifier -> the repo-relative files that name it as a column transformer. */
function referencedTransformers(): Map<string, string[]> {
  const references = new Map<string, string[]>();
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(root)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(TRANSFORMER_REFERENCE)) {
        const name = match[1] as string;
        const sites = references.get(name) ?? [];
        sites.push(relative(REPO_ROOT, file));
        references.set(name, sites);
      }
    }
  }
  return references;
}

describe('INVARIANT: a ValueTransformer leaves an unprovided column to its DEFAULT', () => {
  const referenced = referencedTransformers();

  it('knows about every transformer a column declaration names', () => {
    const unregistered = [...referenced.keys()]
      .filter((name) => !REGISTERED_ALIASES.has(name))
      .map((name) => `${name} (first used in ${referenced.get(name)?.[0]})`)
      .sort();
    // A new transformer is caught here rather than by the column that breaks
    // months later: add it to TRANSFORMERS and the assertions below run on it.
    expect(unregistered).toEqual([]);
  });

  it('does not carry a registry entry no column uses any more', () => {
    const unused = TRANSFORMERS.filter(
      (entry) => !entry.aliases.some((alias) => referenced.has(alias)),
    )
      .map((entry) => entry.aliases[0] as string)
      .sort();
    expect(unused).toEqual([]);
  });

  describe.each(TRANSFORMERS.map((entry) => [entry.aliases[0] as string, entry] as const))(
    '%s',
    (_name, entry) => {
      it('returns undefined for undefined, so TypeORM emits DEFAULT', () => {
        expect(entry.create().to(undefined)).toBeUndefined();
      });

      it('still writes an explicit null, because clearing a column is deliberate', () => {
        expect(entry.create().to(null)).toBeNull();
      });
    },
  );
});
