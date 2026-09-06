/**
 * INVARIANT — one catalogue, and money is a numeric column
 * (BILLING-CRITICAL-002, ADR-0013).
 *
 * A discount, a plan and a price all decide what a subscription and an
 * invoice are worth, and billing is the sole writer of both (D14). The
 * platform carried two catalogues: `admin.discount_codes`,
 * `admin.plan_definitions`, `admin.module_pricing` and `admin.custom_plans`
 * beside `billing.plans`, each with its own rules and its own Stripe
 * identifiers. This gate holds the line as each table moves.
 *
 *   1. A catalogue table has exactly ONE writable entity, and it declares
 *      `schema: 'billing'`. admin-api may map the same table, but only
 *      read-only (`synchronize: false`) — the contract its own CLAUDE.md
 *      states and `admin-api-schema-boundaries.spec.ts` enforces generally.
 *   2. A table that has already moved leaves no trace behind: no entity
 *      declares it under `schema: 'admin'`, and `MODULE_SCHEMAS` lists it
 *      under billing and not under admin.
 *   3. The discount catalogue holds no money inside jsonb. Every amount is
 *      its own `numeric` column, so the database can CHECK it.
 *   4. Money that IS still inside a jsonb column on the billing surface is
 *      governed: `.claude/allowlists/money-in-jsonb.yaml` names each site
 *      with an owner, a future expiry, the finding that normalises it and a
 *      reason, under a ceiling that only decreases. A site that is gone or
 *      fixed fails — the list only shrinks.
 *   5. A Stripe identifier has one writable home. The duplicated ones are in
 *      the same allowlist, ratcheting the same way.
 *
 * The scan is `tests/invariants/lib/catalog-entity-table.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

import {
  REPO_ROOT,
  allEntityDeclarations,
  allJsonbMoneyFields,
  allStripeIdentifierProperties,
  billingSurfaceEntityFiles,
} from './lib/catalog-entity-table';

const ALLOWLIST = '.claude/allowlists/money-in-jsonb.yaml';
const SCHEMA_MANAGER = 'libs/backend-common/src/database/schema-manager.service.ts';

/** Tables that price something. `plans` was always billing's; the rest are moving. */
const CATALOGUE_TABLES = ['discount_codes', 'discount_redemptions', 'plans'] as const;

/** Already moved under ADR-0013 — nothing may declare them in `admin` again. */
const MIGRATED_FROM_ADMIN = ['discount_codes', 'discount_redemptions'] as const;

interface AllowlistEntry {
  site: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface Allowlist {
  ceiling?: number;
  entries?: AllowlistEntry[];
  duplicateStripeIdentifiers?: AllowlistEntry[];
}

function readAllowlist(): Required<Allowlist> {
  const doc = yaml.load(readFileSync(resolve(REPO_ROOT, ALLOWLIST), 'utf8')) as Allowlist;
  return {
    ceiling: doc.ceiling ?? 0,
    entries: doc.entries ?? [],
    duplicateStripeIdentifiers: doc.duplicateStripeIdentifiers ?? [],
  };
}

function expiryIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function assertGoverned(entries: AllowlistEntry[], today: string): void {
  for (const entry of entries) {
    expect(entry.owner.trim().length).toBeGreaterThan(0);
    expect(entry.findingId).toMatch(/^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/);
    expect(entry.reason.trim().length).toBeGreaterThan(20);
    expect(expiryIso(entry.expiry) >= today).toBe(true);
  }
}

/** The table list `MODULE_SCHEMAS` declares for one module, as source text. */
function moduleTableBlock(moduleName: string): string {
  const source = readFileSync(resolve(REPO_ROOT, SCHEMA_MANAGER), 'utf8');
  const start = source.indexOf(`moduleName: '${moduleName}'`);
  expect(start).toBeGreaterThan(-1);
  const tablesAt = source.indexOf('tables: [', start);
  const end = source.indexOf('],', tablesAt);
  return source.slice(tablesAt, end);
}

describe('INVARIANT (BILLING-CRITICAL-002): one catalogue of record, money in numeric columns', () => {
  const entities = allEntityDeclarations();
  const allowlist = readAllowlist();
  const today = new Date().toISOString().slice(0, 10);

  it('sees the fleet', () => {
    expect(entities.length).toBeGreaterThan(200);
    expect(billingSurfaceEntityFiles().length).toBeGreaterThan(5);
  });

  it.each(CATALOGUE_TABLES)(
    'gives %s exactly one writable entity, in the billing schema',
    (table) => {
      const declaring = entities.filter((entity) => entity.table === table);
      expect(declaring.length).toBeGreaterThan(0);

      const writable = declaring.filter((entity) => !entity.readOnly);
      expect(writable.map((entity) => `${entity.id} (schema=${entity.schema})`)).toHaveLength(1);
      expect(writable[0]?.schema).toBe('billing');

      // Every other mapping is a read-only view of billing's table.
      const wrong = declaring
        .filter((entity) => entity.readOnly && entity.schema !== 'billing')
        .map((entity) => `${entity.id} maps ${table} as schema=${entity.schema}`);
      expect(wrong).toEqual([]);
    },
  );

  it.each(MIGRATED_FROM_ADMIN)('leaves no admin declaration of %s behind', (table) => {
    const inAdmin = entities
      .filter((entity) => entity.table === table && entity.schema === 'admin')
      .map((entity) => entity.id);
    expect(inAdmin).toEqual([]);
    expect(moduleTableBlock('billing')).toContain(`'${table}'`);
    expect(moduleTableBlock('admin')).not.toContain(`'${table}'`);
  });

  it('keeps money out of jsonb in the discount catalogue', () => {
    const inDiscounts = allJsonbMoneyFields()
      .filter((field) => /discount-code\.entity\.ts$/.test(field.entityFile))
      .map((field) => `${field.id} is ${field.propertyType}`);
    expect(inDiscounts).toEqual([]);
  });

  it('governs every remaining money-in-jsonb site on the billing surface', () => {
    const found = allJsonbMoneyFields();
    const allowed = new Set(allowlist.entries.map((entry) => entry.site));
    const ungoverned = [
      ...new Set(found.filter((field) => !allowed.has(field.id)).map((field) => field.id)),
    ].sort();
    expect(ungoverned).toEqual([]);

    // The list only shrinks: an entry whose site is gone or fixed fails.
    const foundIds = new Set(found.map((field) => field.id));
    const stale = allowlist.entries
      .map((entry) => entry.site)
      .filter((site) => !foundIds.has(site));
    expect(stale).toEqual([]);
    expect(allowlist.entries.length).toBeLessThanOrEqual(allowlist.ceiling);
    expect(new Set(allowlist.entries.map((entry) => entry.site)).size).toBe(
      allowlist.entries.length,
    );
    assertGoverned(allowlist.entries, today);
  });

  it('gives every Stripe identifier one writable home, and ratchets the duplicates', () => {
    const writable = allStripeIdentifierProperties().filter((property) => !property.readOnly);
    const byProperty = new Map<string, typeof writable>();
    for (const property of writable) {
      byProperty.set(property.property, [...(byProperty.get(property.property) ?? []), property]);
    }

    const allowed = new Set(allowlist.duplicateStripeIdentifiers.map((entry) => entry.site));
    const ungoverned: string[] = [];
    const stillDuplicated: string[] = [];
    for (const [name, declarations] of byProperty) {
      if (declarations.length === 1) continue;
      // billing is the authoritative home; every other writable declaration
      // must be named in the allowlist as scheduled for deletion.
      const others = declarations.filter((property) => property.schema !== 'billing');
      if (declarations.length - others.length !== 1) {
        stillDuplicated.push(`${name}: ${declarations.map((d) => d.id).join(', ')}`);
      }
      ungoverned.push(...others.filter((property) => !allowed.has(property.id)).map((p) => p.id));
    }
    expect(stillDuplicated.sort()).toEqual([]);
    expect(ungoverned.sort()).toEqual([]);

    const writableIds = new Set(writable.map((property) => property.id));
    const stale = allowlist.duplicateStripeIdentifiers
      .map((entry) => entry.site)
      .filter((site) => !writableIds.has(site));
    expect(stale).toEqual([]);
    assertGoverned(allowlist.duplicateStripeIdentifiers, today);
  });
});
