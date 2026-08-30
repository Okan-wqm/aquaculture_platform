import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-INFRA-HIGH-003 Part B — per-tenant payload-key store for event-store
 * crypto-shred. Holds the KEK-wrapped per-tenant DEK; destroying a row's DEK on
 * erasure crypto-shreds every stored_events payload encrypted under it.
 *
 * Cross-tenant infrastructure table in `event_store` (source-schema, never
 * per-tenant cloned). Additive; blue-green safe.
 */
@SourceOnlyMigration({
  reason:
    'tenant_payload_keys is a source-schema per-tenant DEK store for event-store crypto-shred',
})
export class CreateTenantPayloadKeys1801100000000 implements MigrationInterface {
  name = 'CreateTenantPayloadKeys1801100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_store.tenant_payload_keys (
        tenant_id   uuid NOT NULL,
        wrapped_dek text NOT NULL,
        key_version smallint NOT NULL DEFAULT 1,
        created_at  timestamptz NOT NULL DEFAULT now(),
        shredded_at timestamptz,
        CONSTRAINT pk_tenant_payload_keys PRIMARY KEY (tenant_id)
      )
    `);
    // Fast lookup of not-yet-shredded keys.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_payload_keys_active
        ON event_store.tenant_payload_keys (tenant_id)
        WHERE shredded_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS event_store.idx_tenant_payload_keys_active`);
    await queryRunner.query(`DROP TABLE IF EXISTS event_store.tenant_payload_keys`);
  }
}
