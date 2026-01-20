import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add System Hierarchy Support
 *
 * This migration adds:
 * 1. parent_system_id to systems table (self-referencing for nested systems)
 * 2. system_id to equipment table (link equipment to systems)
 * 3. parent_equipment_id to equipment table (self-referencing for nested equipment)
 *
 * Hierarchy: Site -> Department -> System -> Equipment
 * With recursive relations:
 * - System -> parentSystem (systems can contain sub-systems)
 * - Equipment -> parentEquipment (equipment can contain sub-equipment)
 */
export class AddSystemHierarchy1734336000000 implements MigrationInterface {
  name = 'AddSystemHierarchy1734336000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if we're in the farm schema
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running migration in schema:', schema);

    // 1. Add parent_system_id to systems table
    const systemsHasParentCol = await this.columnExists(queryRunner, 'systems', 'parent_system_id');
    if (!systemsHasParentCol) {
      await queryRunner.query(`
        ALTER TABLE "systems"
        ADD COLUMN "parent_system_id" uuid
      `);

      // Add foreign key constraint
      await queryRunner.query(`
        ALTER TABLE "systems"
        ADD CONSTRAINT "FK_systems_parent_system"
        FOREIGN KEY ("parent_system_id")
        REFERENCES "systems"("id")
        ON DELETE SET NULL
      `);

      // Add index for better query performance
      await queryRunner.query(`
        CREATE INDEX "IDX_systems_parent_system_id"
        ON "systems"("parent_system_id")
        WHERE "parent_system_id" IS NOT NULL
      `);

      console.log('Added parent_system_id to systems table');
    } else {
      console.log('parent_system_id already exists in systems table, skipping');
    }

    // 2. Add system_id to equipment table
    const equipmentHasSystemCol = await this.columnExists(queryRunner, 'equipment', 'system_id');
    if (!equipmentHasSystemCol) {
      await queryRunner.query(`
        ALTER TABLE "equipment"
        ADD COLUMN "system_id" uuid
      `);

      // Add foreign key constraint
      await queryRunner.query(`
        ALTER TABLE "equipment"
        ADD CONSTRAINT "FK_equipment_system"
        FOREIGN KEY ("system_id")
        REFERENCES "systems"("id")
        ON DELETE SET NULL
      `);

      // Add index
      await queryRunner.query(`
        CREATE INDEX "IDX_equipment_system_id"
        ON "equipment"("system_id")
        WHERE "system_id" IS NOT NULL
      `);

      console.log('Added system_id to equipment table');
    } else {
      console.log('system_id already exists in equipment table, skipping');
    }

    // 3. Add parent_equipment_id to equipment table
    const equipmentHasParentCol = await this.columnExists(queryRunner, 'equipment', 'parent_equipment_id');
    if (!equipmentHasParentCol) {
      await queryRunner.query(`
        ALTER TABLE "equipment"
        ADD COLUMN "parent_equipment_id" uuid
      `);

      // Add foreign key constraint
      await queryRunner.query(`
        ALTER TABLE "equipment"
        ADD CONSTRAINT "FK_equipment_parent_equipment"
        FOREIGN KEY ("parent_equipment_id")
        REFERENCES "equipment"("id")
        ON DELETE SET NULL
      `);

      // Add index
      await queryRunner.query(`
        CREATE INDEX "IDX_equipment_parent_equipment_id"
        ON "equipment"("parent_equipment_id")
        WHERE "parent_equipment_id" IS NOT NULL
      `);

      console.log('Added parent_equipment_id to equipment table');
    } else {
      console.log('parent_equipment_id already exists in equipment table, skipping');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove parent_equipment_id from equipment
    const equipmentHasParentCol = await this.columnExists(queryRunner, 'equipment', 'parent_equipment_id');
    if (equipmentHasParentCol) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_equipment_parent_equipment_id"`);
      await queryRunner.query(`ALTER TABLE "equipment" DROP CONSTRAINT IF EXISTS "FK_equipment_parent_equipment"`);
      await queryRunner.query(`ALTER TABLE "equipment" DROP COLUMN "parent_equipment_id"`);
    }

    // Remove system_id from equipment
    const equipmentHasSystemCol = await this.columnExists(queryRunner, 'equipment', 'system_id');
    if (equipmentHasSystemCol) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_equipment_system_id"`);
      await queryRunner.query(`ALTER TABLE "equipment" DROP CONSTRAINT IF EXISTS "FK_equipment_system"`);
      await queryRunner.query(`ALTER TABLE "equipment" DROP COLUMN "system_id"`);
    }

    // Remove parent_system_id from systems
    const systemsHasParentCol = await this.columnExists(queryRunner, 'systems', 'parent_system_id');
    if (systemsHasParentCol) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_systems_parent_system_id"`);
      await queryRunner.query(`ALTER TABLE "systems" DROP CONSTRAINT IF EXISTS "FK_systems_parent_system"`);
      await queryRunner.query(`ALTER TABLE "systems" DROP COLUMN "parent_system_id"`);
    }
  }

  /**
   * Helper to check if a column exists
   */
  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }
}
