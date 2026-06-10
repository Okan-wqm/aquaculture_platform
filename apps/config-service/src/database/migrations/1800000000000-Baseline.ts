import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "config"."configurations_value_type_enum" AS ENUM('string', 'number', 'boolean', 'json', 'secret'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "config"."configurations_environment_enum" AS ENUM('development', 'staging', 'production', 'all'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "config"."configurations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenant_id" uuid NOT NULL, "service" character varying(100) NOT NULL, "key" character varying(255) NOT NULL, "value" text NOT NULL, "value_type" "config"."configurations_value_type_enum" NOT NULL DEFAULT 'string', "environment" "config"."configurations_environment_enum" NOT NULL DEFAULT 'all', "description" character varying(500), "is_secret" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, "deleted_at" TIMESTAMP, "deleted_by" character varying(100), "delete_reason" character varying(255), "retention_until" TIMESTAMP, "suppress_fallback" boolean NOT NULL DEFAULT false, "default_value" character varying(255), "validation_rules" jsonb, "category" character varying(50), "tags" text array, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "created_by" character varying(100), "updated_by" character varying(100), "version" integer NOT NULL, CONSTRAINT "UQ_901a57aa24cde3513c40a662a59" UNIQUE ("tenant_id", "service", "key", "environment"), CONSTRAINT "PK_ef9fc29709cc5fc66610fc6a664" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bf3645260755e9a8e3ab75f2de" ON "config"."configurations" ("tenant_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6815959c70427c326a013ae02b" ON "config"."configurations" ("service") `);
        await queryRunner.query(`CREATE INDEX "IDX_862351304f050ede746dd216b1" ON "config"."configurations" ("is_active") `);
        await queryRunner.query(`CREATE INDEX "IDX_9aa7726d3b5716e81dd5227ed8" ON "config"."configurations" ("service", "key") `);
        await queryRunner.query(`CREATE INDEX "IDX_a1cc7151ac8c21b680dfdf0d67" ON "config"."configurations" ("tenant_id", "service") `);
        await queryRunner.query(`CREATE TABLE "config"."configuration_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "configuration_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "service" character varying(100) NOT NULL, "key" character varying(255) NOT NULL, "previous_value" text NOT NULL, "new_value" text NOT NULL, "changed_by" character varying(100) NOT NULL, "changed_at" TIMESTAMP NOT NULL, "change_reason" character varying(255), CONSTRAINT "PK_8b79092e79f38b442e76753f797" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5e3aa2847a93a22438ca6f1072" ON "config"."configuration_history" ("configuration_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba91b77a3d75873d58a082a029" ON "config"."configuration_history" ("tenant_id", "changed_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_4148f1b3c94688080823e0b3bc" ON "config"."configuration_history" ("configuration_id", "changed_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "config"."IDX_4148f1b3c94688080823e0b3bc"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_ba91b77a3d75873d58a082a029"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_5e3aa2847a93a22438ca6f1072"`);
        await queryRunner.query(`DROP TABLE "config"."configuration_history"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_a1cc7151ac8c21b680dfdf0d67"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_9aa7726d3b5716e81dd5227ed8"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_862351304f050ede746dd216b1"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_6815959c70427c326a013ae02b"`);
        await queryRunner.query(`DROP INDEX "config"."IDX_bf3645260755e9a8e3ab75f2de"`);
        await queryRunner.query(`DROP TABLE "config"."configurations"`);
        await queryRunner.query(`DROP TYPE "config"."configurations_environment_enum"`);
        await queryRunner.query(`DROP TYPE "config"."configurations_value_type_enum"`);
    }

}
