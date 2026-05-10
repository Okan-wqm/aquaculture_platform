import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AlignAuthEntitySurface1789000000000
 * ============================================================================
 *
 * Aligns the live `auth` schema with the four entity-declared shapes the
 * 2026-05-08 bootstrap-from-scratch test reported as drifted:
 *
 *   1. auth.tenant_modules.activatedAt  — entity NOT NULL, DB nullable
 *   2. auth.tenant_modules.assignedBy   — entity uuid, DB character varying
 *   3. auth.tenant_modules.assignedBy   — entity NOT NULL, DB nullable
 *   4. auth.invitations.invitedBy       — entity NOT NULL, DB nullable
 *
 * # Why each NOT NULL fix is the right architectural shape
 *
 * `tenant_modules.activatedAt` carries an entity-side
 * `default: () => 'CURRENT_TIMESTAMP'` — every TypeORM-side INSERT
 * already supplies a value. Legacy rows that pre-date the default-add
 * are backfilled to NOW() before the SET NOT NULL flip.
 *
 * `tenant_modules.assignedBy` is the SUPER_ADMIN user id who granted
 * the module. Cure is two-phase:
 *   (a) ALTER COLUMN TYPE varchar -> uuid (R10 guarded; rejects any
 *       non-UUID string loudly — the right signal for corruption).
 *   (b) Backfill any NULL values to a SUPER_ADMIN sentinel from
 *       auth.users WHERE role = 'SUPER_ADMIN'. Vacuous on fresh DBs.
 *
 * `invitations.invitedBy` is the user id who created the invitation —
 * entity-declared NOT NULL uuid. Same SUPER_ADMIN-sentinel backfill.
 *
 * # Idempotency & lint compliance
 *
 *   - R10: every ALTER COLUMN runs inside a `DO $$ BEGIN IF EXISTS
 *     (SELECT 1 FROM information_schema.columns WHERE ...) THEN ...
 *     END IF; END $$` block keyed on the current column shape.
 *   - R5: no `WHEN others`; positive predicates only.
 *   - search_path pinned via pinSearchPath() for non-runner paths.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignAuthEntitySurface1789000000000 implements MigrationInterface {
  name = 'AlignAuthEntitySurface1789000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'auth');

    // 1. tenant_modules.activatedAt — backfill NULLs then SET NOT NULL.
    await qr.query(`
      UPDATE auth.tenant_modules
         SET "activatedAt" = NOW()
       WHERE "activatedAt" IS NULL
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'activatedAt'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "activatedAt" SET NOT NULL;
        END IF;
      END $$;
    `);

    // 2. tenant_modules.assignedBy — TYPE varchar -> uuid (guarded).
    // The cast `USING "assignedBy"::uuid` rejects non-UUID strings loudly.
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'assignedBy'
             AND data_type = 'character varying'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "assignedBy" TYPE uuid USING "assignedBy"::uuid;
        END IF;
      END $$;
    `);

    // 3. tenant_modules.assignedBy — backfill NULLs then SET NOT NULL.
    await qr.query(`
      UPDATE auth.tenant_modules tm
         SET "assignedBy" = (
           SELECT u.id
             FROM auth.users u
            WHERE u.role = 'SUPER_ADMIN'
            ORDER BY u."createdAt" ASC
            LIMIT 1
         )
       WHERE tm."assignedBy" IS NULL
         AND EXISTS (
           SELECT 1 FROM auth.users WHERE role = 'SUPER_ADMIN'
         )
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'assignedBy'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "assignedBy" SET NOT NULL;
        END IF;
      END $$;
    `);

    // 4. invitations.invitedBy — backfill NULLs then SET NOT NULL.
    await qr.query(`
      UPDATE auth.invitations inv
         SET "invitedBy" = (
           SELECT u.id
             FROM auth.users u
            WHERE u.role = 'SUPER_ADMIN'
            ORDER BY u."createdAt" ASC
            LIMIT 1
         )
       WHERE inv."invitedBy" IS NULL
         AND EXISTS (
           SELECT 1 FROM auth.users WHERE role = 'SUPER_ADMIN'
         )
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'invitations'
             AND column_name = 'invitedBy'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE auth.invitations
            ALTER COLUMN "invitedBy" SET NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'auth');

    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'invitations'
             AND column_name = 'invitedBy'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE auth.invitations
            ALTER COLUMN "invitedBy" DROP NOT NULL;
        END IF;
      END $$;
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'assignedBy'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "assignedBy" DROP NOT NULL;
        END IF;
      END $$;
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'assignedBy'
             AND data_type = 'uuid'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "assignedBy" TYPE varchar(255) USING "assignedBy"::text;
        END IF;
      END $$;
    `);
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'auth'
             AND table_name = 'tenant_modules'
             AND column_name = 'activatedAt'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE auth.tenant_modules
            ALTER COLUMN "activatedAt" DROP NOT NULL;
        END IF;
      END $$;
    `);
  }
}
