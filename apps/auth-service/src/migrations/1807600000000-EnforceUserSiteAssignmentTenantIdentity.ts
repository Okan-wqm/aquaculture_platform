import {
  pinSearchPath,
  SourceOnlyMigration,
  withDdlSafety,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { dropConcurrentIndex, ensureConcurrentBtreeIndex } from './support/concurrent-index';

const USER_TENANT_UNIQUE_INDEX = {
  schema: 'auth',
  table: 'users',
  name: 'UQ_users_id_tenant',
  columns: ['id', 'tenantId'],
  unique: true,
} as const;

const ASSIGNMENT_LOOKUP_INDEX = {
  schema: 'auth',
  table: 'user_site_assignments',
  name: 'IDX_user_site_assignments_user_tenant',
  columns: ['userId', 'tenantId'],
  unique: false,
} as const;

/**
 * Bind every site assignment to the same tenant as its auth user.
 * Invalid historical rows are access grants with no legitimate owner. The
 * migration refuses to continue when any exist: operators must investigate
 * and remediate them explicitly rather than losing authorization history via
 * an automatic destructive rewrite.
 */
@SourceOnlyMigration({
  reason: 'auth user-site assignment tenant identity is source-owned',
})
export class EnforceUserSiteAssignmentTenantIdentity1807600000000 implements MigrationInterface {
  name = 'EnforceUserSiteAssignmentTenantIdentity1807600000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      async () => {
        await queryRunner.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM auth.user_site_assignments assignment
              WHERE NOT EXISTS (
                SELECT 1
                FROM auth.users user_account
                WHERE user_account."id" = assignment."userId"
                  AND user_account."tenantId" = assignment."tenantId"
              )
            ) THEN
              RAISE EXCEPTION USING
                MESSAGE = 'Refusing to enforce user-site tenant identity: mismatched or orphaned assignments exist',
                HINT = 'Investigate and remediate auth.user_site_assignments explicitly before retrying the migration';
            END IF;
          END
          $$
        `);

        await ensureConcurrentBtreeIndex(queryRunner, USER_TENANT_UNIQUE_INDEX);
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_state
              WHERE constraint_state.conrelid = 'auth.users'::regclass
                AND constraint_state.conname = 'UQ_users_id_tenant'
            ) THEN
              ALTER TABLE auth.users
              ADD CONSTRAINT "UQ_users_id_tenant"
              UNIQUE USING INDEX "UQ_users_id_tenant";
            END IF;
          END
          $$
        `);
        await queryRunner.query(`
          DO $$
          DECLARE
            actual_type "char";
            actual_columns text[];
            actual_deferrable boolean;
            actual_deferred boolean;
          BEGIN
            SELECT
              constraint_state.contype,
              ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_state.conkey)
                  WITH ORDINALITY AS keys(attnum, ordinality)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_state.conrelid
                 AND attribute.attnum = keys.attnum
                ORDER BY keys.ordinality
              ),
              constraint_state.condeferrable,
              constraint_state.condeferred
              INTO actual_type, actual_columns, actual_deferrable, actual_deferred
            FROM pg_constraint constraint_state
            WHERE constraint_state.conrelid = 'auth.users'::regclass
              AND constraint_state.conname = 'UQ_users_id_tenant';

            IF actual_type IS DISTINCT FROM 'u'
               OR actual_columns IS DISTINCT FROM ARRAY['id', 'tenantId']::text[]
               OR actual_deferrable IS DISTINCT FROM false
               OR actual_deferred IS DISTINCT FROM false THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'auth.UQ_users_id_tenant schema drift';
            END IF;
          END
          $$
        `);

        await ensureConcurrentBtreeIndex(queryRunner, ASSIGNMENT_LOOKUP_INDEX);
        // UQ_user_site remains the sole assignment identity. User.id is a global
        // primary key, so adding tenantId to the same key would be an overlapping,
        // redundant uniqueness contract. Tenant ownership is enforced separately
        // and canonically by the composite foreign key below.
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_state
              WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
                AND constraint_state.conname = 'FK_user_site_assignments_user_tenant'
            ) THEN
              ALTER TABLE auth.user_site_assignments
              ADD CONSTRAINT "FK_user_site_assignments_user_tenant"
              FOREIGN KEY ("userId", "tenantId")
              REFERENCES auth.users ("id", "tenantId")
              ON DELETE CASCADE
              NOT VALID;
            END IF;
          END
          $$
        `);
        await this.assertCompositeForeignKey(queryRunner);
        await queryRunner.query(`
          ALTER TABLE auth.user_site_assignments
          VALIDATE CONSTRAINT "FK_user_site_assignments_user_tenant"
        `);
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_state
              WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
                AND constraint_state.conname = 'FK_user_site_assignments_user_tenant'
                AND constraint_state.convalidated
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'auth.FK_user_site_assignments_user_tenant is not validated';
            END IF;
          END
          $$
        `);
        await queryRunner.query(`
          ALTER TABLE auth.user_site_assignments
          DROP CONSTRAINT IF EXISTS "FK_user_site_assignments_user"
        `);
      },
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await withDdlSafety(
      queryRunner,
      { schema: 'auth', nonTransactionalDdl: true, advisoryLockKeySuffix: 'auth' },
      async () => {
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_state
              WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
                AND constraint_state.conname = 'FK_user_site_assignments_user'
            ) THEN
              ALTER TABLE auth.user_site_assignments
              ADD CONSTRAINT "FK_user_site_assignments_user"
              FOREIGN KEY ("userId") REFERENCES auth.users ("id") ON DELETE CASCADE
              NOT VALID;
            END IF;
          END
          $$
        `);
        await this.assertLegacyForeignKey(queryRunner);
        await queryRunner.query(`
          ALTER TABLE auth.user_site_assignments
          VALIDATE CONSTRAINT "FK_user_site_assignments_user"
        `);
        await queryRunner.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint constraint_state
              WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
                AND constraint_state.conname = 'FK_user_site_assignments_user'
                AND constraint_state.convalidated
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'auth.FK_user_site_assignments_user is not validated';
            END IF;
          END
          $$
        `);
        await queryRunner.query(`
          ALTER TABLE auth.user_site_assignments
          DROP CONSTRAINT IF EXISTS "FK_user_site_assignments_user_tenant"
        `);
        await dropConcurrentIndex(queryRunner, 'auth', ASSIGNMENT_LOOKUP_INDEX.name);
        await queryRunner.query(`
          ALTER TABLE auth.users
          DROP CONSTRAINT IF EXISTS "UQ_users_id_tenant"
        `);
        await dropConcurrentIndex(queryRunner, 'auth', USER_TENANT_UNIQUE_INDEX.name);
      },
    );
  }

  private async assertCompositeForeignKey(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        actual_type "char";
        actual_columns text[];
        referenced_columns text[];
        actual_delete_action "char";
        actual_update_action "char";
        actual_match_type "char";
        actual_deferrable boolean;
        actual_deferred boolean;
      BEGIN
        SELECT
          constraint_state.contype,
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_state.conkey)
              WITH ORDINALITY AS keys(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_state.conrelid
             AND attribute.attnum = keys.attnum
            ORDER BY keys.ordinality
          ),
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_state.confkey)
              WITH ORDINALITY AS keys(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_state.confrelid
             AND attribute.attnum = keys.attnum
            ORDER BY keys.ordinality
          ),
          constraint_state.confdeltype,
          constraint_state.confupdtype,
          constraint_state.confmatchtype,
          constraint_state.condeferrable,
          constraint_state.condeferred
          INTO actual_type, actual_columns, referenced_columns,
               actual_delete_action, actual_update_action, actual_match_type,
               actual_deferrable, actual_deferred
        FROM pg_constraint constraint_state
        WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
          AND constraint_state.confrelid = 'auth.users'::regclass
          AND constraint_state.conname = 'FK_user_site_assignments_user_tenant';

        IF actual_type IS DISTINCT FROM 'f'
           OR actual_columns IS DISTINCT FROM ARRAY['userId', 'tenantId']::text[]
           OR referenced_columns IS DISTINCT FROM ARRAY['id', 'tenantId']::text[]
           OR actual_delete_action IS DISTINCT FROM 'c'
           OR actual_update_action IS DISTINCT FROM 'a'
           OR actual_match_type IS DISTINCT FROM 's'
           OR actual_deferrable IS DISTINCT FROM false
           OR actual_deferred IS DISTINCT FROM false THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'auth.FK_user_site_assignments_user_tenant schema drift';
        END IF;
      END
      $$
    `);
  }

  private async assertLegacyForeignKey(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        actual_type "char";
        actual_columns text[];
        referenced_columns text[];
        actual_delete_action "char";
        actual_update_action "char";
        actual_match_type "char";
        actual_deferrable boolean;
        actual_deferred boolean;
      BEGIN
        SELECT
          constraint_state.contype,
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_state.conkey)
              WITH ORDINALITY AS keys(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_state.conrelid
             AND attribute.attnum = keys.attnum
            ORDER BY keys.ordinality
          ),
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_state.confkey)
              WITH ORDINALITY AS keys(attnum, ordinality)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_state.confrelid
             AND attribute.attnum = keys.attnum
            ORDER BY keys.ordinality
          ),
          constraint_state.confdeltype,
          constraint_state.confupdtype,
          constraint_state.confmatchtype,
          constraint_state.condeferrable,
          constraint_state.condeferred
          INTO actual_type, actual_columns, referenced_columns,
               actual_delete_action, actual_update_action, actual_match_type,
               actual_deferrable, actual_deferred
        FROM pg_constraint constraint_state
        WHERE constraint_state.conrelid = 'auth.user_site_assignments'::regclass
          AND constraint_state.confrelid = 'auth.users'::regclass
          AND constraint_state.conname = 'FK_user_site_assignments_user';

        IF actual_type IS DISTINCT FROM 'f'
           OR actual_columns IS DISTINCT FROM ARRAY['userId']::text[]
           OR referenced_columns IS DISTINCT FROM ARRAY['id']::text[]
           OR actual_delete_action IS DISTINCT FROM 'c'
           OR actual_update_action IS DISTINCT FROM 'a'
           OR actual_match_type IS DISTINCT FROM 's'
           OR actual_deferrable IS DISTINCT FROM false
           OR actual_deferred IS DISTINCT FROM false THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'auth.FK_user_site_assignments_user schema drift';
        END IF;
      END
      $$
    `);
  }
}
