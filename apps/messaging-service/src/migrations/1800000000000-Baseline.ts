import { MigrationInterface, QueryRunner } from "typeorm";

import { applyTenantRlsToSchema, removeTenantRlsFromSchema } from '@aquaculture/backend-common/database'; // Faz 3.5 RLS additions: import block
export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "channel_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "channelId" uuid NOT NULL, "userId" uuid NOT NULL, "role" character varying(20) NOT NULL DEFAULT 'member', "notificationPreference" character varying(20) NOT NULL DEFAULT 'all', "lastReadAt" TIMESTAMP WITH TIME ZONE, "joinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "leftAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_channel_member" UNIQUE ("channelId", "userId"), CONSTRAINT "PK_95976b619edca48aed364c70c36" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_channel_members_tenant" ON "channel_members" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_channel_members_channel_id" ON "channel_members" ("channelId") `);
        await queryRunner.query(`CREATE INDEX "idx_channel_members_user_id" ON "channel_members" ("userId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "channels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "type" character varying(20) NOT NULL DEFAULT 'group', "name" character varying(100), "description" text, "avatarUrl" character varying(1024), "createdBy" uuid, "isArchived" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "dmPairKey" character varying(73), "aiPersona" character varying(50), "aiServiceUrl" character varying(512), CONSTRAINT "UQ_f09d2340f139791474c776042a8" UNIQUE ("dmPairKey"), CONSTRAINT "CHK_b38ddeaf364da5a5d1e0b2210b" CHECK (("type" = 'direct' AND "dmPairKey" IS NOT NULL) OR ("type" != 'direct' AND "dmPairKey" IS NULL)), CONSTRAINT "CHK_4711b7360fd55fcf9bb91c6692" CHECK ("type" IN ('direct', 'group', 'ai')), CONSTRAINT "PK_bc603823f3f741359c2339389f9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_channels_tenant" ON "channels" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_channels_created_by" ON "channels" ("createdBy") `);
        await queryRunner.query(`CREATE INDEX "idx_channels_type" ON "channels" ("type") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "message_attachments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "storageKey" character varying(512) NOT NULL, "originalFilename" character varying(255) NOT NULL, "mimeType" character varying(127) NOT NULL, "fileSize" bigint NOT NULL, "width" integer, "height" integer, "durationSeconds" numeric(10,2), "thumbnailKey" character varying(512), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "is_deleted" boolean NOT NULL DEFAULT false, "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_e5085d973567c61e9306f10f95b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d74af46c250f065d510cf7b4f7" ON "message_attachments" ("is_deleted") `);
        await queryRunner.query(`CREATE INDEX "idx_attachments_tenant" ON "message_attachments" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_attachments_message" ON "message_attachments" ("messageId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "message_receipts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "userId" uuid NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'delivered', "deliveredAt" TIMESTAMP WITH TIME ZONE, "readAt" TIMESTAMP WITH TIME ZONE, "receiptCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), CONSTRAINT "CHK_2fed702fdd8a7d1c5e6a5925ec" CHECK ("status" IN ('delivered', 'read')), CONSTRAINT "PK_38feda673852bdf8d2b9b2f2edc" PRIMARY KEY ("id", "receiptCreatedAt")) PARTITION BY RANGE ("receiptCreatedAt")`);
        await queryRunner.query(`CREATE INDEX "idx_receipts_tenant" ON "message_receipts" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_receipts_message" ON "message_receipts" ("messageId") `);
        await queryRunner.query(`CREATE INDEX "idx_receipts_user_status" ON "message_receipts" ("userId", "status") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "message_reactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "userId" uuid NOT NULL, "emoji" character varying(32) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_reaction_message_user_emoji" UNIQUE ("messageId", "userId", "emoji"), CONSTRAINT "PK_654a9f0059ff93a8f156be66a5b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_reactions_tenant" ON "message_reactions" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_reactions_message" ON "message_reactions" ("messageId") `);
        // PK is composite (id, createdAt) to match the entity's two @PrimaryColumn
        // decorators in apps/messaging-service/src/message/entities/message.entity.ts.
        // 6 child tables (message_attachments, message_receipts, message_reactions,
        // pinned_messages, message_entity_references, message_analysis) carry FK
        // constraints `REFERENCES messaging.messages(id, createdAt)` — PostgreSQL
        // requires the referenced columns to participate in PRIMARY KEY or a
        // UNIQUE INDEX, so a single-column PK on "id" alone makes every FK
        // constraint creation fail with "no unique constraint matching given keys".
        // The composite shape is also the standard TimescaleDB hypertable contract
        // (partition column included in PK) — keeping the door open for a future
        // hypertable on createdAt without another PK migration.
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "messages" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "channelId" uuid NOT NULL, "senderId" uuid NOT NULL, "content" text, "contentType" character varying(20) NOT NULL DEFAULT 'text', "parentId" uuid, "forwardedFrom" uuid, "idempotencyKey" uuid NOT NULL, "isDeleted" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "editedAt" TIMESTAMP WITH TIME ZONE, "updatedBy" uuid, "isAiGenerated" boolean NOT NULL DEFAULT false, "metadata" jsonb, CONSTRAINT "CHK_860d0b704cc2f0938b989e0131" CHECK ("contentType" IN ('text', 'image', 'file', 'voice', 'system')), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id", "createdAt")) PARTITION BY RANGE ("createdAt")`);
        await queryRunner.query(`CREATE INDEX "idx_messages_idempotency" ON "messages" ("tenantId", "idempotencyKey") `);
        await queryRunner.query(`CREATE INDEX "idx_messages_tenant" ON "messages" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_messages_sender" ON "messages" ("senderId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_messages_channel_created" ON "messages" ("channelId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "pinned_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "channelId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "pinnedBy" uuid NOT NULL, "pinnedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_pin_channel_message" UNIQUE ("channelId", "messageId"), CONSTRAINT "PK_f27ff551aca1df5eb7af6079b67" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_pins_tenant" ON "pinned_messages" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_pins_channel" ON "pinned_messages" ("channelId", "pinnedAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "retention_policies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "channelId" uuid, "retentionDays" integer NOT NULL DEFAULT '365', "createdBy" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_retention_tenant_channel" UNIQUE ("tenantId", "channelId"), CONSTRAINT "PK_c0f79bfde72a93e544c780a7470" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_retention_tenant" ON "retention_policies" ("tenantId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "legal_holds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "channelId" uuid, "legalMatterId" uuid NOT NULL, "legalMatterDescription" text, "reason" text NOT NULL, "requestedBy" uuid, "startedBy" uuid NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "releasedBy" uuid, "releasedByApprover" uuid, "releaseReason" text, "releasedAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE, "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_bbe3e0c98678909493a90442dfb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_legal_hold_channel" ON "legal_holds" ("channelId") WHERE "isActive" = true`);
        await queryRunner.query(`CREATE INDEX "idx_legal_hold_tenant_active" ON "legal_holds" ("tenantId", "isActive") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "compliance_audit_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tenantId" uuid NOT NULL, "userId" uuid NOT NULL, "action" character varying(30) NOT NULL, "resourceType" character varying(50) NOT NULL, "resourceId" uuid NOT NULL, "details" jsonb, "ipAddress" character varying(45), "userAgent" character varying(512), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_93afc46bf6769904c70d2afbf68" PRIMARY KEY ("id", "createdAt"))`);
        await queryRunner.query(`CREATE INDEX "idx_compliance_audit_action_created" ON "compliance_audit_log" ("action", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_compliance_audit_user_created" ON "compliance_audit_log" ("userId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "idx_compliance_audit_tenant_created" ON "compliance_audit_log" ("tenantId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "user_ai_consents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "userId" uuid NOT NULL, "consented" boolean NOT NULL DEFAULT false, "consentedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b1c485ab78e9b2166266dc5dbe2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "messaging"."tenant_ai_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "aiEnabled" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_c71eae8e33479eb1de64ed4c7d0" UNIQUE ("tenantId"), CONSTRAINT "PK_c62e7414c6bb62e25543b8a1d09" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "message_entity_references" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "entityType" character varying(30) NOT NULL, "entityId" uuid NOT NULL, "confidence" numeric(3,2) NOT NULL DEFAULT '1', "extractedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), CONSTRAINT "uq_message_entity" UNIQUE ("messageId", "entityType", "entityId"), CONSTRAINT "CHK_058520a837f2d5879ff4cc4613" CHECK ("entityType" IN ('tank', 'batch', 'site', 'species', 'parameter')), CONSTRAINT "PK_994a033fd6191508e93ca204c1d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_entity_refs_tenant" ON "message_entity_references" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_entity_refs_message" ON "message_entity_references" ("messageId") `);
        await queryRunner.query(`CREATE INDEX "idx_entity_refs_entity" ON "message_entity_references" ("entityType", "entityId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "message_analysis" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "messageId" uuid NOT NULL, "messageCreatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "analysisType" character varying(20) NOT NULL, "result" jsonb NOT NULL, "modelVersion" character varying(64) NOT NULL, "analyzedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), CONSTRAINT "CHK_1b81386034f50a229d27214303" CHECK ("analysisType" IN ('sentiment', 'entity', 'topic')), CONSTRAINT "PK_5462a0c7407dc9fd50e7fcf95b3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_analysis_tenant" ON "message_analysis" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_analysis_type" ON "message_analysis" ("analysisType", "analyzedAt") `);
        await queryRunner.query(`CREATE INDEX "idx_analysis_message" ON "message_analysis" ("messageId") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "knowledge_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "sourceMessageId" uuid, "sourceMessageCreatedAt" TIMESTAMP WITH TIME ZONE, "category" character varying(50) NOT NULL, "content" text NOT NULL, "entities" jsonb, "confidence" numeric(3,2) NOT NULL DEFAULT '1', "verifiedBy" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5c344c4dc5439f5679927ad1f40" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_knowledge_tenant" ON "knowledge_entries" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "idx_knowledge_category" ON "knowledge_entries" ("category", "createdAt") `);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "messaging"."embeddings_metadata" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "modelName" character varying(128) NOT NULL, "modelVersion" character varying(64) NOT NULL, "dimension" integer NOT NULL, "distanceMetric" character varying(20) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "uq_active_model" UNIQUE ("modelName", "isActive"), CONSTRAINT "PK_c0786b2d46e4fc890e1e32819fd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`DROP INDEX "idx_analysis_type"`);
        await queryRunner.query(`CREATE INDEX "idx_analysis_type" ON "message_analysis" ("analysisType", "analyzedAt") `);
        await queryRunner.query(`ALTER TABLE "channel_members" ADD CONSTRAINT "FK_db73d12c31aa45d249f6efeaa01" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "message_attachments" ADD CONSTRAINT "FK_feba9c7cced72676c716bc3e7bd" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "message_receipts" ADD CONSTRAINT "FK_113e9f1bde01433819f03b64dec" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "message_reactions" ADD CONSTRAINT "FK_22658274347308477aff2ac94b5" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pinned_messages" ADD CONSTRAINT "FK_dc6b1f46ce54f1f186f7be467d1" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pinned_messages" ADD CONSTRAINT "FK_1eeca1ccc15159c0444e46c63bb" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "message_entity_references" ADD CONSTRAINT "FK_bb838c8f5f3a05818a99b3df865" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "message_analysis" ADD CONSTRAINT "FK_300a3fda524de884763af2697dd" FOREIGN KEY ("messageId", "messageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "knowledge_entries" ADD CONSTRAINT "FK_c5a793a94bb4d551916c3912ffd" FOREIGN KEY ("sourceMessageId", "sourceMessageCreatedAt") REFERENCES "messages"("id","createdAt") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // ── Faz 3.5 hand-author addition — RLS canonical predicate ──
        await applyTenantRlsToSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });

        // ── Faz 3.5 hand-author addition — audit immutability triggers ──
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION compliance_audit_log_prevent_update_or_delete()
            RETURNS trigger AS $auditguard$
            BEGIN
              RAISE EXCEPTION 'Audit table "compliance_audit_log" is append-only; UPDATE/DELETE refused (Faz 1.4 protected-tables-guard).';
            END;
            $auditguard$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER trg_compliance_audit_log_prevent_update
            BEFORE UPDATE OR DELETE ON "compliance_audit_log"
            FOR EACH ROW EXECUTE FUNCTION compliance_audit_log_prevent_update_or_delete();
        `);
        await queryRunner.query(`
            REVOKE UPDATE, DELETE ON "compliance_audit_log" FROM PUBLIC;
        `);
    }

    // ── GENERATED postCondition (DATA-CRITICAL-010) — do not hand-edit ──
    public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
        const rows: Array<{ missing: string }> = await queryRunner.query(`
            SELECT expected.table_name AS missing
              FROM (VALUES ('channel_members'), ('channels'), ('compliance_audit_log'), ('knowledge_entries'), ('legal_holds'), ('message_analysis'), ('message_attachments'), ('message_entity_references'), ('message_reactions'), ('message_receipts'), ('messages'), ('pinned_messages'), ('retention_policies'), ('user_ai_consents')) AS expected(table_name)
             WHERE NOT EXISTS (
               SELECT 1
                 FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name = expected.table_name
             )
        `);
        return rows.length === 0;
    }
    // ── END GENERATED postCondition ──

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse Faz 3.5 audit immutability triggers
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_compliance_audit_log_prevent_update ON "compliance_audit_log";`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS compliance_audit_log_prevent_update_or_delete();`);
        // Reverse Faz 3.5 RLS install first (avoids policy-on-missing-table errors).
        await removeTenantRlsFromSchema(queryRunner, {
            tenantIdColumns: ['tenant_id', 'tenantId'],
            excludeTables: [],
        });
        await queryRunner.query(`ALTER TABLE "knowledge_entries" DROP CONSTRAINT "FK_c5a793a94bb4d551916c3912ffd"`);
        await queryRunner.query(`ALTER TABLE "message_analysis" DROP CONSTRAINT "FK_300a3fda524de884763af2697dd"`);
        await queryRunner.query(`ALTER TABLE "message_entity_references" DROP CONSTRAINT "FK_bb838c8f5f3a05818a99b3df865"`);
        await queryRunner.query(`ALTER TABLE "pinned_messages" DROP CONSTRAINT "FK_1eeca1ccc15159c0444e46c63bb"`);
        await queryRunner.query(`ALTER TABLE "pinned_messages" DROP CONSTRAINT "FK_dc6b1f46ce54f1f186f7be467d1"`);
        await queryRunner.query(`ALTER TABLE "message_reactions" DROP CONSTRAINT "FK_22658274347308477aff2ac94b5"`);
        await queryRunner.query(`ALTER TABLE "message_receipts" DROP CONSTRAINT "FK_113e9f1bde01433819f03b64dec"`);
        await queryRunner.query(`ALTER TABLE "message_attachments" DROP CONSTRAINT "FK_feba9c7cced72676c716bc3e7bd"`);
        await queryRunner.query(`ALTER TABLE "channel_members" DROP CONSTRAINT "FK_db73d12c31aa45d249f6efeaa01"`);
        await queryRunner.query(`DROP INDEX "idx_analysis_type"`);
        await queryRunner.query(`CREATE INDEX "idx_analysis_type" ON "message_analysis" ("analysisType", "analyzedAt") `);
        await queryRunner.query(`DROP TABLE "messaging"."embeddings_metadata"`);
        await queryRunner.query(`DROP INDEX "idx_knowledge_category"`);
        await queryRunner.query(`DROP INDEX "idx_knowledge_tenant"`);
        await queryRunner.query(`DROP TABLE "knowledge_entries"`);
        await queryRunner.query(`DROP INDEX "idx_analysis_message"`);
        await queryRunner.query(`DROP INDEX "idx_analysis_type"`);
        await queryRunner.query(`DROP INDEX "idx_analysis_tenant"`);
        await queryRunner.query(`DROP TABLE "message_analysis"`);
        await queryRunner.query(`DROP INDEX "idx_entity_refs_entity"`);
        await queryRunner.query(`DROP INDEX "idx_entity_refs_message"`);
        await queryRunner.query(`DROP INDEX "idx_entity_refs_tenant"`);
        await queryRunner.query(`DROP TABLE "message_entity_references"`);
        await queryRunner.query(`DROP TABLE "messaging"."tenant_ai_settings"`);
        await queryRunner.query(`DROP TABLE "user_ai_consents"`);
        await queryRunner.query(`DROP INDEX "idx_compliance_audit_tenant_created"`);
        await queryRunner.query(`DROP INDEX "idx_compliance_audit_user_created"`);
        await queryRunner.query(`DROP INDEX "idx_compliance_audit_action_created"`);
        await queryRunner.query(`DROP TABLE "compliance_audit_log"`);
        await queryRunner.query(`DROP INDEX "idx_legal_hold_tenant_active"`);
        await queryRunner.query(`DROP INDEX "idx_legal_hold_channel"`);
        await queryRunner.query(`DROP TABLE "legal_holds"`);
        await queryRunner.query(`DROP INDEX "idx_retention_tenant"`);
        await queryRunner.query(`DROP TABLE "retention_policies"`);
        await queryRunner.query(`DROP INDEX "idx_pins_channel"`);
        await queryRunner.query(`DROP INDEX "idx_pins_tenant"`);
        await queryRunner.query(`DROP TABLE "pinned_messages"`);
        await queryRunner.query(`DROP INDEX "idx_messages_channel_created"`);
        await queryRunner.query(`DROP INDEX "idx_messages_sender"`);
        await queryRunner.query(`DROP INDEX "idx_messages_tenant"`);
        await queryRunner.query(`DROP INDEX "idx_messages_idempotency"`);
        await queryRunner.query(`DROP TABLE "messages"`);
        await queryRunner.query(`DROP INDEX "idx_reactions_message"`);
        await queryRunner.query(`DROP INDEX "idx_reactions_tenant"`);
        await queryRunner.query(`DROP TABLE "message_reactions"`);
        await queryRunner.query(`DROP INDEX "idx_receipts_user_status"`);
        await queryRunner.query(`DROP INDEX "idx_receipts_message"`);
        await queryRunner.query(`DROP INDEX "idx_receipts_tenant"`);
        await queryRunner.query(`DROP TABLE "message_receipts"`);
        await queryRunner.query(`DROP INDEX "idx_attachments_message"`);
        await queryRunner.query(`DROP INDEX "idx_attachments_tenant"`);
        await queryRunner.query(`DROP INDEX "IDX_d74af46c250f065d510cf7b4f7"`);
        await queryRunner.query(`DROP TABLE "message_attachments"`);
        await queryRunner.query(`DROP INDEX "idx_channels_type"`);
        await queryRunner.query(`DROP INDEX "idx_channels_created_by"`);
        await queryRunner.query(`DROP INDEX "idx_channels_tenant"`);
        await queryRunner.query(`DROP TABLE "channels"`);
        await queryRunner.query(`DROP INDEX "idx_channel_members_user_id"`);
        await queryRunner.query(`DROP INDEX "idx_channel_members_channel_id"`);
        await queryRunner.query(`DROP INDEX "idx_channel_members_tenant"`);
        await queryRunner.query(`DROP TABLE "channel_members"`);
    }

}
