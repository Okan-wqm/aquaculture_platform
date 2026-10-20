import { MigrationInterface, QueryRunner } from 'typeorm';

export class EdgeProvisioningReservation1825000000000 implements MigrationInterface {
  name = 'EdgeProvisioningReservation1825000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "agent_channel" character varying(16) NOT NULL DEFAULT 'generic_linux'`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "reserved_binding_method" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "reserved_binding_sha256" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "reservation_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "issued_manifest_sha256" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "credentials_issued_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "device_binding_method" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "device_binding_sha256" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "edge_statement_seq" bigint NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(`ALTER TABLE "edge_devices" ADD "activation_receipt" text`);
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD "activation_receipt_handed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "CHK_edge_devices_device_binding" CHECK (("device_binding_sha256" IS NULL) = ("device_binding_method" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "CHK_edge_devices_reservation_binding" CHECK (("reserved_binding_sha256" IS NULL) = ("reserved_binding_method" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "CHK_edge_devices_agent_channel" CHECK ("agent_channel" IN ('generic_linux', 'suderra_os'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "edge_devices" DROP CONSTRAINT "CHK_edge_devices_agent_channel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" DROP CONSTRAINT "CHK_edge_devices_reservation_binding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" DROP CONSTRAINT "CHK_edge_devices_device_binding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" DROP COLUMN "activation_receipt_handed_at"`,
    );
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "activation_receipt"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "edge_statement_seq"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "device_binding_sha256"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "device_binding_method"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "credentials_issued_at"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "issued_manifest_sha256"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "reservation_expires_at"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "reserved_binding_sha256"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "reserved_binding_method"`);
    await queryRunner.query(`ALTER TABLE "edge_devices" DROP COLUMN "agent_channel"`);
  }
}
