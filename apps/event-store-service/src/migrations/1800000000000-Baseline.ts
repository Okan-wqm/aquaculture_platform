import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "event_store"."projection_checkpoints_status_enum" AS ENUM('running', 'paused', 'stopped', 'faulted')`);
        await queryRunner.query(`CREATE TABLE "event_store"."projection_checkpoints" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectionName" character varying(255) NOT NULL, "description" character varying(500), "position" bigint NOT NULL DEFAULT '0', "status" "event_store"."projection_checkpoints_status_enum" NOT NULL DEFAULT 'running', "tenantId" uuid NOT NULL, "consumerGroup" character varying(100), "eventTypes" jsonb NOT NULL DEFAULT '[]', "aggregateTypes" jsonb NOT NULL DEFAULT '[]', "eventsProcessed" bigint NOT NULL DEFAULT '0', "eventsFailed" bigint NOT NULL DEFAULT '0', "lastError" text, "lastErrorAt" TIMESTAMP WITH TIME ZONE, "avgProcessingTimeMs" double precision NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastProcessedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_70f507452232333f1f0f9043f87" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_79857894fad3b933d4d2ae192a" ON "event_store"."projection_checkpoints" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_fcb5ec546dab48a3040b230181" ON "event_store"."projection_checkpoints" ("tenantId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_29d4c7b6d922e327386fb4667d" ON "event_store"."projection_checkpoints" ("tenantId", "projectionName") `);
        await queryRunner.query(`CREATE TABLE "event_store"."stored_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "streamName" character varying(255) NOT NULL, "globalPosition" bigint NOT NULL, "streamPosition" bigint NOT NULL, "aggregateType" character varying(255) NOT NULL, "aggregateId" uuid NOT NULL, "version" integer NOT NULL, "eventType" character varying(255) NOT NULL, "payload" jsonb NOT NULL, "metadata" jsonb, "tenantId" uuid NOT NULL, "correlationId" uuid, "causationId" uuid, "userId" uuid, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "storedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "schemaVersion" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_7328fbed828c2b2e51e42b67766" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_stored_events_tenant_aggregate_version" ON "event_store"."stored_events" ("tenantId", "aggregateId", "version") `);
        await queryRunner.query(`CREATE INDEX "IDX_239b5387b20fa4764cf948bd21" ON "event_store"."stored_events" ("tenantId", "storedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_e2333e9a266805f39dc6bb4b94" ON "event_store"."stored_events" ("tenantId", "eventType") `);
        await queryRunner.query(`CREATE INDEX "IDX_ce53de21c853fd172c6a11ce01" ON "event_store"."stored_events" ("tenantId", "globalPosition") `);
        await queryRunner.query(`CREATE INDEX "IDX_f4d48d93de16997398b325ab45" ON "event_store"."stored_events" ("tenantId", "streamName", "version") `);
        await queryRunner.query(`CREATE INDEX "IDX_b225d07eac48ae166372bbc759" ON "event_store"."stored_events" ("correlationId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9213b2ad468302bf74878c79e6" ON "event_store"."stored_events" ("occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_46b717a41d1f43ddfb2f98da82" ON "event_store"."stored_events" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f0a5a44cca7ebaab68e15e8c8a" ON "event_store"."stored_events" ("eventType") `);
        await queryRunner.query(`CREATE INDEX "IDX_48f625ce1fa34fcd62e5fc5cea" ON "event_store"."stored_events" ("streamName") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b238050cd7edc5343f34fba655" ON "event_store"."stored_events" ("globalPosition") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_aebc68416a5ae504289cb6893d" ON "event_store"."stored_events" ("aggregateType", "aggregateId", "version") `);
        await queryRunner.query(`CREATE TABLE "event_store"."snapshots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "aggregateType" character varying(255) NOT NULL, "aggregateId" uuid NOT NULL, "version" integer NOT NULL, "state" jsonb NOT NULL, "tenantId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "schemaVersion" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_f5661b5fd4224d23e26a631986b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_49e3cac6f172eaeea8d22738a4" ON "event_store"."snapshots" ("tenantId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f9eb2ef365ee551cb36ce80d5e" ON "event_store"."snapshots" ("aggregateType", "aggregateId", "tenantId") `);
        await queryRunner.query(`CREATE TABLE "event_store"."event_streams" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "streamName" character varying(255) NOT NULL, "aggregateType" character varying(255) NOT NULL, "aggregateId" uuid NOT NULL, "currentVersion" integer NOT NULL DEFAULT '0', "eventCount" bigint NOT NULL DEFAULT '0', "tenantId" uuid NOT NULL, "isDeleted" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastEventAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_58a9c777323c51e32bfad87b30d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8e558c37a2930a2dda3f4ac7bd" ON "event_store"."event_streams" ("aggregateType") `);
        await queryRunner.query(`CREATE INDEX "IDX_5cb412698070d946fd75c2d1b6" ON "event_store"."event_streams" ("tenantId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_30e421c2fe2bf7bd90dc95bef4" ON "event_store"."event_streams" ("tenantId", "streamName") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "event_store"."IDX_30e421c2fe2bf7bd90dc95bef4"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_5cb412698070d946fd75c2d1b6"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_8e558c37a2930a2dda3f4ac7bd"`);
        await queryRunner.query(`DROP TABLE "event_store"."event_streams"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_f9eb2ef365ee551cb36ce80d5e"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_49e3cac6f172eaeea8d22738a4"`);
        await queryRunner.query(`DROP TABLE "event_store"."snapshots"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_aebc68416a5ae504289cb6893d"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_b238050cd7edc5343f34fba655"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_48f625ce1fa34fcd62e5fc5cea"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_f0a5a44cca7ebaab68e15e8c8a"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_46b717a41d1f43ddfb2f98da82"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_9213b2ad468302bf74878c79e6"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_b225d07eac48ae166372bbc759"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_f4d48d93de16997398b325ab45"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_ce53de21c853fd172c6a11ce01"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_e2333e9a266805f39dc6bb4b94"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_239b5387b20fa4764cf948bd21"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_stored_events_tenant_aggregate_version"`);
        await queryRunner.query(`DROP TABLE "event_store"."stored_events"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_29d4c7b6d922e327386fb4667d"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_fcb5ec546dab48a3040b230181"`);
        await queryRunner.query(`DROP INDEX "event_store"."IDX_79857894fad3b933d4d2ae192a"`);
        await queryRunner.query(`DROP TABLE "event_store"."projection_checkpoints"`);
        await queryRunner.query(`DROP TYPE "event_store"."projection_checkpoints_status_enum"`);
    }

}
