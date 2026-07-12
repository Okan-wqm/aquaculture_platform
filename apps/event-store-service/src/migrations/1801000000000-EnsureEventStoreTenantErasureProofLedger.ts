import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DB-INFRA-HIGH-003 — event-store-service tenant-erasure proof ledger.
 *
 * The immutable proof ledger the TenantErasureTargetExecutor writes a proof row
 * to before enqueuing the TenantDataErased event. Source-schema table in
 * `event_store`. Tracked by the tenant-erasure-ssot invariant. NOTE: this closes
 * only the deletable-tables half of event-store erasure (event_streams,
 * snapshots, projection_*). The immutable `stored_events` payload is EXCLUDED
 * from row deletion and awaits the crypto-shred design (Part B of the blueprint).
 */
@SourceOnlyMigration({
  reason:
    'tenant_erasure_target_proofs is a source-schema proof ledger for event-store-service erasure responses',
})
export class EnsureEventStoreTenantErasureProofLedger1801000000000 implements MigrationInterface {
  name = 'EnsureEventStoreTenantErasureProofLedger1801000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'event_store',
      tenantIndexName: 'idx_event_store_erasure_proofs_tenant',
      eventIndexName: 'idx_event_store_erasure_proofs_event',
      targetIndexName: 'idx_event_store_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'event_store',
      tenantIndexName: 'idx_event_store_erasure_proofs_tenant',
      eventIndexName: 'idx_event_store_erasure_proofs_event',
      targetIndexName: 'idx_event_store_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }
}
