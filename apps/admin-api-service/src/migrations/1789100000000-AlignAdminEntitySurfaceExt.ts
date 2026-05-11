import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignAdminEntitySurfaceExt1789100000000
 * ============================================================================
 *
 * Closes the FK-count drift on `admin.user_role_assignments` surfaced by
 * the bootstrap-from-scratch invariant at f22922d1:
 *
 *   admin.user_role_assignments: fk drift: declares 1 @ManyToOne
 *   relation(s) but pg_constraint has only 0 FK(s)
 *
 * The 1789000000000-AlignAdminEntitySurface migration created the
 * `admin.user_role_assignments` table from the entity surface but did
 * not emit the FK declared by the entity's ManyToOne relation:
 *
 *   @ManyToOne(() => TenantRole, { eager: true })
 *   @JoinColumn({ name: 'role_id' })
 *   role!: TenantRole;
 *
 * No `onDelete:` option is specified → TypeORM emits the constraint
 * with PostgreSQL's `NO ACTION` default. NO ACTION is the conservative
 * choice: refuses the parent delete if any child row references it.
 *
 * # Why ON DELETE NO ACTION (not CASCADE / SET NULL)
 *
 *   - NO ACTION is what the entity declares (absent `onDelete:`).
 *   - CASCADE would silently drop user-role assignments when a role is
 *     removed, masking what should be an explicit admin flow.
 *   - SET NULL is forbidden by the column shape — `role_id` is NOT NULL
 *     on the entity. SET NULL would crash on the actual delete.
 *
 * # R11 idempotency
 *
 * The ADD CONSTRAINT statement is wrapped in `DO $$ BEGIN ... EXCEPTION
 * WHEN duplicate_object THEN NULL; END $$`. Narrow exception class per R5.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignAdminEntitySurfaceExt1789100000000
  implements MigrationInterface
{
  name = 'AlignAdminEntitySurfaceExt1789100000000';

  private readonly logger = new MigrationLogger(
    'AlignAdminEntitySurfaceExt1789100000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'admin');

    this.logger.log(
      'Adding FK admin.user_role_assignments.role_id -> auth.tenant_roles(id) ON DELETE NO ACTION.',
    );

    // Add the cross-schema FK for the @ManyToOne(() => TenantRole)
    // relation declared on UserRoleAssignment. NO ACTION matches the
    // entity's absent `onDelete:` option (TypeORM default).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.user_role_assignments
          ADD CONSTRAINT "FK_user_role_assignments_role"
          FOREIGN KEY ("role_id") REFERENCES auth.tenant_roles("id") ON DELETE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    this.logger.log(
      'admin.user_role_assignments FK alignment complete.',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting admin.user_role_assignments FK alignment. Test-environment only.',
    );

    await pinSearchPath(queryRunner, 'admin');

    await queryRunner.query(`
      ALTER TABLE admin.user_role_assignments
        DROP CONSTRAINT IF EXISTS "FK_user_role_assignments_role"
    `);
  }
}
