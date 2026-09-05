import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Companion migration for the 3cdcfe9ac entity edit
 * (security(admin-api): allowlist sort columns and clamp list limits).
 *
 * That commit only REFORMATTED the union-type declarations on
 * security.entity.ts (multi-line formatting) and tightened service-side
 * list clamps — no column, index, or constraint changed. The
 * entity-diff-witness gate requires an explicit migration so an entity
 * edit can never land silently; this no-op records the review decision
 * that the persisted schema is unchanged.
 */
export class SecurityEntityEditCompanion1808300000000 implements MigrationInterface {
  name = 'SecurityEntityEditCompanion1808300000000';

  public async up(): Promise<void> {
    // Intentionally empty: the entity edit carried no DDL.
  }

  public async down(): Promise<void> {
    // Intentionally empty: nothing was changed.
  }
}
