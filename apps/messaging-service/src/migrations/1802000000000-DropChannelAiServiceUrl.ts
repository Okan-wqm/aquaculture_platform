import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MSG-HIGH-060: drop the per-channel `aiServiceUrl` exfiltration vector.
 *
 * `channels` is a PER-TENANT cloned table (it is in the `messaging` module's
 * tenant `tables` set — schema-manager.service.ts). The migration runner pins
 * search_path to `messaging` (source template) and then to each `tenant_<uuid>`
 * schema, so the table name MUST be UNQUALIFIED (resolved against
 * current_schema()) or the DROP only ever touches the source template and every
 * provisioned tenant keeps the column (and its stored endpoints) forever.
 * Mirrors the farm precedent 1801100000000-EncryptFarmWorkerPii.
 *
 * The column let any channel member point the AI at an arbitrary public HTTPS
 * endpoint they controlled; the bridge then POSTed tenantId + the last 50
 * conversation messages there. SSRF validation only blocked internal targets,
 * so it did nothing against exfiltration to an attacker's public server. BYOK
 * (Faz 1) routes all AI through ai-service over NATS with the tenant's own key,
 * so the override is obsolete AND unsafe.
 *
 * Safe drop: the column is nullable and, as of this release, unread by the
 * service (the entity field and the HTTP-forward path are removed in the same
 * change). down() restores the nullable column shape only — prior values are
 * intentionally not recovered (they were security-relevant and are gone).
 */
const TABLE = 'channels';

export class DropChannelAiServiceUrl1802000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "aiServiceUrl"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "aiServiceUrl" character varying(512)`,
    );
  }
}
