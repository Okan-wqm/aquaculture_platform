import { RLS_TENANT_GUC } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { SYSTEM_TENANT_ID } from '../../configuration/configuration.constants';
import {
  TENANT_SETTINGS,
  TENANT_SETTINGS_SERVICE,
} from '../../configuration/tenant-settings/tenant-settings.vocabulary';

/**
 * Seed the tenant settings vocabulary as SYSTEM-tenant rows.
 *
 * # Why defaults must be ROWS
 *
 * admin-api used to answer every tenant-configuration read by calling
 * `createDefaultTenantConfiguration(tenantId)` and serving the result as that
 * tenant's configuration. Same values for every tenant, an id of
 * `legacy:<tenantId>`, epoch timestamps — a TypeScript constant wearing the
 * shape of a database row. Nothing distinguished "this tenant has not set a
 * quota" from "this tenant's quota is 10 GB", so an operator could not tell a
 * default from a decision.
 *
 * Seeding them under SYSTEM makes the difference visible and makes it work:
 * `GetConfigurationsByServiceHandler` already merges tenant rows OVER system
 * rows, so a fresh tenant reads real rows with `source: 'system'`, and the
 * moment an operator saves, that key becomes an ordinary tenant row with
 * `source: 'tenant'`. No code path has to synthesize anything, and the correct
 * behaviour is what happens when nobody does anything.
 *
 * # Derivation, not transcription
 *
 * Every row comes from `TENANT_SETTINGS` (the vocabulary that also feeds the
 * admin panel's generated reader), so the seeded key set cannot drift from the
 * key set the product edits. `tests/invariants/tenant-settings-vocabulary.spec.ts`
 * asserts this migration derives rather than restates them.
 *
 * # SAFETY SHAPE (blue-green safe, idempotent)
 *   * INSERT only, ON CONFLICT DO NOTHING on the
 *     (tenant_id, service, key, environment) unique constraint — a replay never
 *     clobbers an operator-edited value.
 *   * No schema change, no rewrite of existing rows, no NOT NULL step.
 *   * The previous release does not read the `tenant-settings` namespace, so
 *     both releases can run against this data at once.
 */

/** Attribution recorded in created_by/updated_by for seeded rows. */
const SEED_ACTOR = 'seed:tenant-settings';

const INSERT_SEED_ROW_SQL =
  `INSERT INTO "config"."configurations" ` +
  `("tenant_id","service","key","value","value_type","environment","description",` +
  `"is_secret","is_active","category","default_value","created_by","updated_by","version") ` +
  `VALUES ($1,$2,$3,$4,$5::"config"."configurations_value_type_enum",` +
  `'all'::"config"."configurations_environment_enum",$6,false,true,$7,$4,$8,$8,1) ` +
  `ON CONFLICT ("tenant_id","service","key","environment") DO NOTHING`;

export class SeedTenantSettingsDefaults1805500000000 implements MigrationInterface {
  name = 'SeedTenantSettingsDefaults1805500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `config.configurations` carries a FORCE row-level-security policy keyed on
    // the app.current_tenant GUC. The migration runner has no request context,
    // so scope this transaction to the SYSTEM tenant explicitly — these are
    // SYSTEM-tenant rows, and a restricted migration role would otherwise be
    // denied by the deny-by-default policy. Transaction-local (is_local = true),
    // so nothing leaks past this migration.
    await queryRunner.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, SYSTEM_TENANT_ID]);

    for (const setting of TENANT_SETTINGS) {
      await queryRunner.query(INSERT_SEED_ROW_SQL, [
        SYSTEM_TENANT_ID,
        TENANT_SETTINGS_SERVICE,
        setting.key,
        setting.defaultValue,
        setting.valueType,
        setting.description,
        setting.section,
        SEED_ACTOR,
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, SYSTEM_TENANT_ID]);

    // SYSTEM rows only. A tenant's own overrides are that tenant's data and
    // survive a rollback of the defaults they were overriding.
    await queryRunner.query(
      `DELETE FROM "config"."configurations" WHERE "tenant_id" = $1 AND "service" = $2 AND "key" = ANY($3)`,
      [SYSTEM_TENANT_ID, TENANT_SETTINGS_SERVICE, TENANT_SETTINGS.map((setting) => setting.key)],
    );
  }
}
