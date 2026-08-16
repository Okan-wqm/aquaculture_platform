import { MigrationInterface, QueryRunner } from 'typeorm';

import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * RestoreConfigSchemaOwnerBoundary1807400000000
 * ============================================================================
 *
 * Platform bootstrap stage 008 is the role-map authority: schema DDL belongs
 * to the NOLOGIN `config_schema_owner` role and the `config_service` login is
 * the runtime identity. `1800100000000-OwnConfigTablesByConfigService` runs
 * after bootstrap on a fresh database and historically moved ownership of the
 * schema itself back to the runtime role while repairing table ownership for
 * the legacy boot-time RLS installer.
 *
 * RLS needs the two domain tables to remain owned by `config_service`; it does
 * not require ownership of the containing schema. This forward-only migration
 * therefore restores only the stage-008 schema boundary. Missing or login-
 * enabled owner roles fail closed: silently skipping would record this
 * migration while leaving the runtime credential able to drop its schema.
 */
export class RestoreConfigSchemaOwnerBoundary1807400000000 implements MigrationInterface {
  name = 'RestoreConfigSchemaOwnerBoundary1807400000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'config');

    await queryRunner.query(`
      DO $config_schema_owner_boundary$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_roles
           WHERE rolname = 'config_schema_owner'
             AND NOT rolcanlogin
        ) THEN
          RAISE EXCEPTION
            'config_schema_owner must exist as NOLOGIN; run platform bootstrap stage 008 before config migrations';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'config_service'
        ) THEN
          RAISE EXCEPTION
            'config_service role does not exist; refusing to record an unverifiable ownership boundary';
        END IF;

        ALTER SCHEMA config OWNER TO config_schema_owner;

        -- The runtime keeps the privileges used by the legacy migration/RLS
        -- path, but ownership (DROP SCHEMA / schema-wide reassignment) stays on
        -- the non-login authority declared by stage 008.
        GRANT USAGE, CREATE ON SCHEMA config TO config_service;
      END
      $config_schema_owner_boundary$;
    `);

    this.logger.log(
      'config schema ownership restored to the stage-008 NOLOGIN authority; domain table ownership remains unchanged.',
    );
  }

  /**
   * Assert both halves of the bounded contract. The owner role must exist and
   * remain NOLOGIN, the runtime role must not inherit it, and both RLS-managed
   * domain tables must still belong to the runtime role.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      WITH roles AS (
        SELECT
          owner_role.oid AS owner_oid,
          owner_role.rolcanlogin AS owner_can_login,
          runtime_role.oid AS runtime_oid
        FROM pg_catalog.pg_roles owner_role
        CROSS JOIN pg_catalog.pg_roles runtime_role
        WHERE owner_role.rolname = 'config_schema_owner'
          AND runtime_role.rolname = 'config_service'
      ),
      domain_tables AS (
        SELECT c.relname, r.rolname AS owner_name
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'config'
           AND c.relkind IN ('r', 'p')
           AND c.relname IN ('configurations', 'configuration_history')
      )
      SELECT (
        (SELECT COUNT(*) = 1 AND NOT BOOL_OR(owner_can_login) FROM roles)
        AND (SELECT pg_get_userbyid(nspowner) = 'config_schema_owner'
               FROM pg_catalog.pg_namespace
              WHERE nspname = 'config')
        AND NOT COALESCE(
          (SELECT pg_has_role(runtime_oid, owner_oid, 'MEMBER') FROM roles),
          true
        )
        AND (SELECT COUNT(*) = 2 FROM domain_tables)
        AND NOT EXISTS (
          SELECT 1 FROM domain_tables WHERE owner_name <> 'config_service'
        )
      ) AS ok
    `);

    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down intentionally does nothing: returning schema ownership to a login role would reopen the privilege boundary.',
    );
  }
}
