/**
 * @module AddAiPersonaColumns
 * @description Adds aiPersona and aiServiceUrl columns to the channels table
 * for AI persona-based messaging channels. Both columns are nullable to
 * support existing channels and non-AI channel types.
 *
 * Runs in each tenant schema and the messaging source schema.
 *
 * @see ADR-012 Phase 4 (AI Persona-Based Messaging Channels)
 */
import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertSafeSchemaName } from '@aquaculture/backend-common';

export class AddAiPersonaColumns1711800000002 implements MigrationInterface {
  name = 'AddAiPersonaColumns1711800000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Get current schema (works for both source schema and per-tenant schemas)
    const rows = await queryRunner.query(
      `SELECT current_schema()`,
    ) as Array<{ current_schema: string }>;
    const schema = rows[0]!.current_schema;
    assertSafeSchemaName(schema); // defense-in-depth before SQL interpolation

    // Add aiPersona column: nullable varchar(50) for persona IDs like 'expert-v1'
    await queryRunner.query(`
      ALTER TABLE "${schema}"."channels"
      ADD COLUMN IF NOT EXISTS "aiPersona" VARCHAR(50) NULL
    `);

    // Add aiServiceUrl column: nullable varchar(512) for custom MCP server URLs
    await queryRunner.query(`
      ALTER TABLE "${schema}"."channels"
      ADD COLUMN IF NOT EXISTS "aiServiceUrl" VARCHAR(512) NULL
    `);

    // Index on aiPersona for filtering AI channels by persona
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channels_ai_persona"
      ON "${schema}"."channels" ("aiPersona")
      WHERE "aiPersona" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const downRows = await queryRunner.query(
      `SELECT current_schema()`,
    ) as Array<{ current_schema: string }>;
    const schema = downRows[0]!.current_schema;
    assertSafeSchemaName(schema);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "${schema}"."idx_channels_ai_persona"
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."channels"
      DROP COLUMN IF EXISTS "aiServiceUrl"
    `);

    await queryRunner.query(`
      ALTER TABLE "${schema}"."channels"
      DROP COLUMN IF EXISTS "aiPersona"
    `);
  }
}
