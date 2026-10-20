import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable delivery of the statements a Suderra OS agent hands to root, and a
 * committed activation that survives re-provisioning (ADR-048 DEC-5.8,
 * DEC-5.12, DEC-5.14).
 *
 * # Why
 *
 * 1825000000000 kept the activation receipt on the row but nothing else a
 * redelivery needs, and modelled re-provisioning by clearing the commit
 * itself: a Suderra OS device whose re-provisioning window lapsed looked
 * never-activated, so "regenerate token" revoked the credential the live
 * device still used. The columns here keep the committed activation
 * (`activation_id`, `activated_at`) apart from the current token, store the
 * device-lifecycle statement that opens a re-provisioning window with the
 * window's end, and pace both hand-overs (`*_sent_at`) so any replica
 * redelivers until the agent reports the statement handed to root.
 * `token_issued_at` bounds the age of a token a Suderra OS manifest is
 * issued under (DEC-5.12).
 *
 * # Backfill
 *
 * `activated_at` takes `token_used_at` for every committed row. A receipt
 * stored by 1825000000000 gets its `activation_id`, `activated_at` and
 * `expires_at` from its own signed payload (base64 JSON), so a pending receipt
 * can be re-signed under the same activation. `token_issued_at` stays NULL for
 * tokens issued before it was recorded: no Suderra OS manifest is issued
 * under one (fail closed; the generic channel does not read it).
 *
 * # Tenant routing
 *
 * `edge_devices` is per-tenant: run once per schema with the search_path
 * pinned, unqualified, skipped for a schema without the table. Every
 * statement is replay-safe. Blue-green safe: nullable columns only; the CHECK
 * constraints hold for every backfilled row.
 */
export class EdgeRootHandoffDelivery1826000000000 implements MigrationInterface {
  name = 'EdgeRootHandoffDelivery1826000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    if (!(await hasEdgeDevices(queryRunner))) return;
    for (const [column, type] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "edge_devices" ADD COLUMN IF NOT EXISTS "${column}" ${type}`,
      );
    }
    await queryRunner.query(
      `UPDATE "edge_devices" SET "activated_at" = "token_used_at"
        WHERE "token_used_at" IS NOT NULL AND "activated_at" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "edge_devices" AS d
          SET "activation_id" = (r.body->>'activation_id')::uuid,
              "activated_at" = (r.body->>'activated_at')::timestamptz,
              "activation_receipt_expires_at" = (r.body->>'expires_at')::timestamptz
         FROM (SELECT "id",
                      convert_from(decode(("activation_receipt"::jsonb)->>'payload', 'base64'), 'UTF8')::jsonb AS body
                 FROM "edge_devices"
                WHERE "activation_receipt" IS NOT NULL
                  AND "activation_receipt_expires_at" IS NULL) AS r
        WHERE d."id" = r."id"`,
    );
    for (const [name, expression] of CHECKS) {
      await queryRunner.query(
        `DO $$ BEGIN
           ALTER TABLE "edge_devices" ADD CONSTRAINT "${name}" CHECK (${expression});
         EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    if (!(await hasEdgeDevices(queryRunner))) return;
    for (const [name] of [...CHECKS].reverse()) {
      await queryRunner.query(`ALTER TABLE "edge_devices" DROP CONSTRAINT IF EXISTS "${name}"`);
    }
    for (const [column] of [...COLUMNS].reverse()) {
      await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}

const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['token_issued_at', 'TIMESTAMP WITH TIME ZONE'],
  ['activation_id', 'uuid'],
  ['activated_at', 'TIMESTAMP WITH TIME ZONE'],
  ['activation_receipt_expires_at', 'TIMESTAMP WITH TIME ZONE'],
  ['activation_receipt_sent_at', 'TIMESTAMP WITH TIME ZONE'],
  ['lifecycle_request', 'text'],
  ['lifecycle_request_sent_at', 'TIMESTAMP WITH TIME ZONE'],
  ['lifecycle_request_handed_at', 'TIMESTAMP WITH TIME ZONE'],
  ['maintenance_expires_at', 'TIMESTAMP WITH TIME ZONE'],
];

const BINDING_METHODS = `('tpm-ek-sha256', 'bcm2711-serial-otp-sha256', 'dmi-product-uuid-sha256')`;

/** Byte-identical to the entity's @Check expressions (edge-device.entity.ts). */
const CHECKS: ReadonlyArray<readonly [string, string]> = [
  [
    'CHK_edge_devices_binding_methods',
    `("device_binding_method" IS NULL OR "device_binding_method" IN ${BINDING_METHODS}) AND ` +
      `("reserved_binding_method" IS NULL OR "reserved_binding_method" IN ${BINDING_METHODS})`,
  ],
  [
    'CHK_edge_devices_activation_receipt',
    '("activation_receipt" IS NULL) = ("activation_receipt_expires_at" IS NULL)',
  ],
  [
    'CHK_edge_devices_lifecycle_request',
    '("lifecycle_request" IS NULL) = ("maintenance_expires_at" IS NULL)',
  ],
];

async function hasEdgeDevices(queryRunner: QueryRunner): Promise<boolean> {
  const [row]: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass('edge_devices') IS NOT NULL AS ready`,
  );
  return row !== undefined && row.ready;
}
