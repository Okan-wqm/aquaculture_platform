import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "hydroponics"."hydroponics_config" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "config_name" character varying(255) NOT NULL DEFAULT 'Default', "settings" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8f76b7cbf6ee0aee15412c44e2b" UNIQUE ("tenant_id", "config_name"), CONSTRAINT "PK_fb61a2e995a67c89204a89a725b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_00dd22c917aa1ce6578bc9d7c7" ON "hydroponics"."hydroponics_config" ("tenant_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "hydroponics"."IDX_00dd22c917aa1ce6578bc9d7c7"`);
        await queryRunner.query(`DROP TABLE "hydroponics"."hydroponics_config"`);
    }

}
