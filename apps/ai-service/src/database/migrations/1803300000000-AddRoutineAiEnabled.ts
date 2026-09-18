/**
 * FARM-AI Sprint 1.2 (2026-09-18): add `tenant_agent_configs.routineAiEnabled`
 * (boolean NOT NULL DEFAULT false) — tenant opt-in for the routine
 * orchestrator (Faz 5). Ships OFF: nothing machine-driven runs until the
 * tenant turns it on. The first reader is the Faz-5 routine orchestrator.
 *
 * The table name is UNQUALIFIED on purpose: db-migrate runs this migration
 * once per schema (the source `ai` + every tenant clone — the table is in the
 * schema-manager's tenant tables set), so a qualified name would only ever
 * touch the source template. Idempotent (IF NOT EXISTS) so a re-run is a
 * no-op. Mirrors 1803100000000-AddZaiApiKey.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'tenant_agent_configs';

export class AddRoutineAiEnabled1803300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "routineAiEnabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "routineAiEnabled"`,
    );
  }
}
