import { MigrationInterface, QueryRunner } from "typeorm";

export class Baseline1800000000000 implements MigrationInterface {
    name = 'Baseline1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."audit_logs_severity_enum" AS ENUM('info', 'warning', 'error', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "performedBy" character varying(100) NOT NULL, "performedByEmail" character varying(100), "action" character varying(100) NOT NULL, "entityType" character varying(50) NOT NULL, "entityId" uuid, "tenantId" uuid, "details" jsonb, "previousValue" jsonb, "newValue" jsonb, "severity" "auth"."audit_logs_severity_enum" NOT NULL DEFAULT 'info', "requestId" character varying(100), "sessionId" character varying(100), "ipAddress" inet, "userAgent" character varying(500), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "legalHold" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_audit_entity" ON "auth"."audit_logs" ("entityType", "entityId", "tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_performer_tenant" ON "auth"."audit_logs" ("performedBy", "tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_audit_tenant_created" ON "auth"."audit_logs" ("tenantId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "auth"."tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "slug" character varying(100) NOT NULL, "description" text, "logoUrl" character varying(500), "contactEmail" character varying(255), "contactPhone" character varying(50), "address" text, "taxId" character varying(100), "status" character varying(20) NOT NULL DEFAULT 'PENDING', "plan" character varying(20) NOT NULL DEFAULT 'starter', "maxUsers" integer NOT NULL DEFAULT '5', "max_storage" integer NOT NULL DEFAULT '-1', "is_trial_active" boolean NOT NULL DEFAULT false, "user_count" integer NOT NULL DEFAULT '0', "farm_count" integer NOT NULL DEFAULT '0', "sensor_count" integer NOT NULL DEFAULT '0', "trialEndsAt" TIMESTAMP WITH TIME ZONE, "subscriptionEndsAt" TIMESTAMP WITH TIME ZONE, "customDomain" character varying(255), "settings" jsonb, "createdBy" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "version" integer NOT NULL, CONSTRAINT "UQ_2310ecc5cb8be427097154b18fc" UNIQUE ("slug"), CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tenants_customDomain" ON "auth"."tenants" ("customDomain") WHERE "customDomain" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_tenants_status" ON "auth"."tenants" ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_tenants_slug" ON "auth"."tenants" ("slug") `);
        await queryRunner.query(`CREATE TABLE "auth"."modules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(50) NOT NULL, "name" character varying(100) NOT NULL, "description" text, "icon" character varying(50), "color" character varying(20), "isActive" boolean NOT NULL DEFAULT true, "sortOrder" integer NOT NULL DEFAULT '0', "defaultRoute" character varying(100) NOT NULL, "features" text, "price" numeric(10,2) DEFAULT '0', "is_core" boolean DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_25b42b11ac8b697cdb2eddcef1a" UNIQUE ("code"), CONSTRAINT "PK_7dbefd488bd96c5bf31f0ce0c95" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_modules_code" ON "auth"."modules" ("code") `);
        await queryRunner.query(`CREATE TABLE "auth"."tenant_modules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "moduleId" uuid NOT NULL, "isEnabled" boolean NOT NULL DEFAULT true, "configuration" jsonb, "maxModuleUsers" integer, "activatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, "notes" text, "assignedBy" uuid NOT NULL, "managerId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_tenant_module" UNIQUE ("tenantId", "moduleId"), CONSTRAINT "PK_b0d534b6c523b8b1d5e64aa23c8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_tenant_modules_module" ON "auth"."tenant_modules" ("moduleId") `);
        await queryRunner.query(`CREATE INDEX "IDX_tenant_modules_tenant" ON "auth"."tenant_modules" ("tenantId") `);
        await queryRunner.query(`CREATE TABLE "auth"."mobile_user_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "tenant_id" uuid NOT NULL, "allowed_features" jsonb NOT NULL DEFAULT '{"mortality":true,"cull":true,"harvest":true,"feeding":true,"waterQuality":true,"tankView":true,"transfer":true,"schedule":true,"attendance":true,"leave":true,"tasks":true,"storage":true}', "is_mobile_enabled" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_76c12cbb4a336a22672ee4a8f40" UNIQUE ("user_id"), CONSTRAINT "PK_8c60a9a4d4d96c1a522256b42c6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."support_tickets_category_enum" AS ENUM('technical', 'billing', 'feature_request', 'bug', 'general'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."support_tickets_priority_enum" AS ENUM('critical', 'high', 'medium', 'low'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."support_tickets_status_enum" AS ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."support_tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticketNumber" character varying NOT NULL, "tenantId" uuid NOT NULL, "subject" character varying NOT NULL, "description" text NOT NULL, "category" "auth"."support_tickets_category_enum" NOT NULL, "priority" "auth"."support_tickets_priority_enum" NOT NULL DEFAULT 'medium', "status" "auth"."support_tickets_status_enum" NOT NULL DEFAULT 'open', "assignedTo" uuid, "assignedToName" character varying(255), "reportedBy" uuid NOT NULL, "reportedByName" character varying NOT NULL, "commentCount" integer NOT NULL DEFAULT '0', "slaResponseDeadline" TIMESTAMP WITH TIME ZONE, "slaResolutionDeadline" TIMESTAMP WITH TIME ZONE, "firstResponseAt" TIMESTAMP WITH TIME ZONE, "resolvedAt" TIMESTAMP WITH TIME ZONE, "satisfactionRating" integer, "satisfactionComment" text, "tags" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6e4c71fa5e96520463e92aa02d9" UNIQUE ("ticketNumber"), CONSTRAINT "PK_942e8d8f5df86100471d2324643" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7f39d4242941c82c75c939c7e0" ON "auth"."support_tickets" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_11d8635c21eeba3de3e8769424" ON "auth"."support_tickets" ("priority", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_58d3701b67654aa893d1d093f6" ON "auth"."support_tickets" ("assignedTo", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_e0936f43c38a118dbabd50297e" ON "auth"."support_tickets" ("tenantId", "status") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."ticket_comments_authortype_enum" AS ENUM('super_admin', 'tenant_admin', 'system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."ticket_comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticketId" uuid NOT NULL, "authorId" uuid NOT NULL, "authorName" character varying NOT NULL, "authorType" "auth"."ticket_comments_authortype_enum" NOT NULL, "content" text NOT NULL, "isInternal" boolean NOT NULL DEFAULT false, "attachments" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_811ed3b81dd8df6b9a92058d89c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f6beba8ae36e1ce20968d7a319" ON "auth"."ticket_comments" ("ticketId") `);
        await queryRunner.query(`CREATE INDEX "IDX_61d6c935d0da6b5a918d5e58cd" ON "auth"."ticket_comments" ("ticketId", "createdAt") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."message_threads_status_enum" AS ENUM('open', 'closed', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."message_threads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tenantId" uuid NOT NULL, "subject" character varying NOT NULL, "lastMessage" text, "lastMessageAt" TIMESTAMP WITH TIME ZONE, "lastMessageBy" uuid, "status" "auth"."message_threads_status_enum" NOT NULL DEFAULT 'open', "messageCount" integer NOT NULL DEFAULT '0', "unreadCountAdmin" integer NOT NULL DEFAULT '0', "unreadCountTenant" integer NOT NULL DEFAULT '0', "createdBy" uuid NOT NULL, "createdByAdmin" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_257a191f664b9470b5d94f98264" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8bccdf9b34dc6b06fc2636856f" ON "auth"."message_threads" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5dffedd696eda85e924dc3f1e8" ON "auth"."message_threads" ("tenantId", "updatedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b26c662365bb483150f26e4a9" ON "auth"."message_threads" ("tenantId", "status") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."messages_sendertype_enum" AS ENUM('super_admin', 'tenant_admin', 'system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."messages_status_enum" AS ENUM('sent', 'delivered', 'read'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "threadId" uuid NOT NULL, "senderId" uuid NOT NULL, "senderType" "auth"."messages_sendertype_enum" NOT NULL, "senderName" character varying NOT NULL, "content" text NOT NULL, "status" "auth"."messages_status_enum" NOT NULL DEFAULT 'sent', "isInternal" boolean NOT NULL DEFAULT false, "attachments" jsonb, "readAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_15f9bd2bf472ff12b6ee20012d" ON "auth"."messages" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_37e3e110ca0d8b7a51ef50f256" ON "auth"."messages" ("threadId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "auth"."users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(255) NOT NULL, "password" character varying(255), "firstName" character varying(100), "lastName" character varying(100), "role" character varying(50) NOT NULL DEFAULT 'MODULE_USER', "tenantId" uuid, "accessType" character varying(20) DEFAULT 'BOTH', "isActive" boolean NOT NULL DEFAULT true, "isEmailVerified" boolean NOT NULL DEFAULT false, "invitationToken" character varying(128), "invitationExpiresAt" TIMESTAMP WITH TIME ZONE, "invitedBy" uuid, "profileImageUrl" character varying(500), "phoneNumber" character varying(20), "preferredLanguage" character varying(10) DEFAULT 'tr', "notificationPreferences" jsonb, "mfaEnabled" boolean NOT NULL DEFAULT false, "mfaSecret" character varying(512), "mfaRecoveryCodes" text, "mfaFailedAttempts" integer NOT NULL DEFAULT '0', "mfaLockedUntil" TIMESTAMP WITH TIME ZONE, "lastLoginAt" TIMESTAMP WITH TIME ZONE, "lastLoginIp" character varying(50), "passwordResetToken" character varying(128), "passwordResetExpires" TIMESTAMP WITH TIME ZONE, "failedLoginAttempts" integer NOT NULL DEFAULT '0', "lockedUntil" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_users_password_reset_token" ON "auth"."users" ("passwordResetToken") WHERE "passwordResetToken" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_users_invitation_token" ON "auth"."users" ("invitationToken") WHERE "invitationToken" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_users_role" ON "auth"."users" ("role") `);
        await queryRunner.query(`CREATE INDEX "IDX_users_tenant" ON "auth"."users" ("tenantId") `);
        await queryRunner.query(`CREATE TABLE "auth"."webauthn_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "credentialId" character varying(512) NOT NULL, "publicKey" text NOT NULL, "counter" integer NOT NULL DEFAULT '0', "transports" text, "deviceName" character varying(100) NOT NULL DEFAULT 'Biometric Device', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "lastUsedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f5a100358f652926a5abae5e431" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_webauthn_credential_id" ON "auth"."webauthn_credentials" ("credentialId") `);
        await queryRunner.query(`CREATE INDEX "IDX_webauthn_user" ON "auth"."webauthn_credentials" ("userId") `);
        await queryRunner.query(`CREATE TABLE "auth"."user_module_assignments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "moduleId" uuid NOT NULL, "tenantId" uuid NOT NULL, "isPrimaryManager" boolean NOT NULL DEFAULT false, "isActive" boolean NOT NULL DEFAULT true, "permissions" jsonb, "assignedBy" uuid NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE, "notes" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_user_module" UNIQUE ("userId", "moduleId"), CONSTRAINT "PK_1894975bec32119992d4ca80a3c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_user_module_assignments_tenant" ON "auth"."user_module_assignments" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_module_assignments_module" ON "auth"."user_module_assignments" ("moduleId") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_module_assignments_user" ON "auth"."user_module_assignments" ("userId") `);
        await queryRunner.query(`CREATE TABLE "auth"."invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying(128) NOT NULL, "email" character varying(255) NOT NULL, "firstName" character varying(100), "lastName" character varying(100), "role" character varying(50) NOT NULL, "tenantId" uuid, "moduleIds" text, "primaryModuleId" uuid, "status" character varying(20) NOT NULL DEFAULT 'PENDING', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "acceptedAt" TIMESTAMP WITH TIME ZONE, "userId" uuid, "message" text, "invitedBy" uuid NOT NULL, "sendCount" integer NOT NULL DEFAULT '1', "lastSentAt" TIMESTAMP WITH TIME ZONE, "acceptedFromIp" character varying(50), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_e577dcf9bb6d084373ed3998509" UNIQUE ("token"), CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_invitations_status" ON "auth"."invitations" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_invitations_tenant" ON "auth"."invitations" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_invitations_email" ON "auth"."invitations" ("email") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_invitations_token" ON "auth"."invitations" ("token") `);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."announcements_type_enum" AS ENUM('info', 'warning', 'critical', 'maintenance'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."announcements_status_enum" AS ENUM('draft', 'scheduled', 'published', 'expired', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`DO $$ BEGIN CREATE TYPE "auth"."announcements_scope_enum" AS ENUM('platform', 'tenant'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await queryRunner.query(`CREATE TABLE "auth"."announcements" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying NOT NULL, "content" text NOT NULL, "type" "auth"."announcements_type_enum" NOT NULL DEFAULT 'info', "status" "auth"."announcements_status_enum" NOT NULL DEFAULT 'draft', "scope" "auth"."announcements_scope_enum" NOT NULL, "tenantId" uuid, "isGlobal" boolean NOT NULL DEFAULT true, "targetCriteria" jsonb, "publishAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE, "requiresAcknowledgment" boolean NOT NULL DEFAULT false, "viewCount" integer NOT NULL DEFAULT '0', "acknowledgmentCount" integer NOT NULL DEFAULT '0', "createdBy" uuid NOT NULL, "createdByName" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b3ad760876ff2e19d58e05dc8b0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_29f5be1631fdc08ce2ad6a9c03" ON "auth"."announcements" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fabf411618aba4c3c7790fd31" ON "auth"."announcements" ("publishAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5f0c9af38fdf3318a0294dfb74" ON "auth"."announcements" ("tenantId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_6f68011926b37a4b428850b85a" ON "auth"."announcements" ("scope", "status") `);
        await queryRunner.query(`CREATE TABLE "auth"."announcement_acknowledgments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "announcementId" uuid NOT NULL, "userId" uuid NOT NULL, "userName" character varying NOT NULL, "tenantId" uuid, "tenantName" character varying(255), "viewedAt" TIMESTAMP NOT NULL DEFAULT now(), "acknowledgedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_28c0b4b7a87307b8e2aa7573af3" UNIQUE ("announcementId", "userId"), CONSTRAINT "PK_2210e80b68c3a16b3d5fcb5eec1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5b31e3f30a25937e045cfba3d6" ON "auth"."announcement_acknowledgments" ("announcementId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba4b92cd3ce9d8fe5fc560661d" ON "auth"."announcement_acknowledgments" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_81a16611785f2db0c09b6250ba" ON "auth"."announcement_acknowledgments" ("userId", "viewedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_28c0b4b7a87307b8e2aa7573af" ON "auth"."announcement_acknowledgments" ("announcementId", "userId") `);
        await queryRunner.query(`CREATE TABLE "auth"."refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "token" character varying(255) NOT NULL, "userId" uuid NOT NULL, "tenantId" uuid, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "isRevoked" boolean NOT NULL DEFAULT false, "revokedAt" TIMESTAMP WITH TIME ZONE, "revokedReason" character varying(255), "userAgent" character varying(500), "ipAddress" character varying(50), "deviceId" character varying(100), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_tenant" ON "auth"."refresh_tokens" ("tenantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_expires" ON "auth"."refresh_tokens" ("expiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_refresh_tokens_token" ON "auth"."refresh_tokens" ("token") `);
        await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_user_revoked" ON "auth"."refresh_tokens" ("userId", "isRevoked") `);
        await queryRunner.query(`ALTER TABLE "auth"."tenant_modules" ADD CONSTRAINT "FK_54b5bb2fadb6ada4fe57a9e2701" FOREIGN KEY ("tenantId") REFERENCES "auth"."tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."tenant_modules" ADD CONSTRAINT "FK_a001196031d22c837d0e45c450e" FOREIGN KEY ("moduleId") REFERENCES "auth"."modules"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."support_tickets" ADD CONSTRAINT "FK_7f39d4242941c82c75c939c7e0c" FOREIGN KEY ("tenantId") REFERENCES "auth"."tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."ticket_comments" ADD CONSTRAINT "FK_f6beba8ae36e1ce20968d7a3192" FOREIGN KEY ("ticketId") REFERENCES "auth"."support_tickets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."message_threads" ADD CONSTRAINT "FK_8bccdf9b34dc6b06fc2636856f4" FOREIGN KEY ("tenantId") REFERENCES "auth"."tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."messages" ADD CONSTRAINT "FK_15f9bd2bf472ff12b6ee20012d0" FOREIGN KEY ("threadId") REFERENCES "auth"."message_threads"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."webauthn_credentials" ADD CONSTRAINT "FK_4e5d1a5131f49fdbc410b8ded04" FOREIGN KEY ("userId") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."user_module_assignments" ADD CONSTRAINT "FK_cdec674320f153ecf8e842cd443" FOREIGN KEY ("userId") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."user_module_assignments" ADD CONSTRAINT "FK_5d42a5b70f4506a9c29fb3bd225" FOREIGN KEY ("moduleId") REFERENCES "auth"."modules"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."announcements" ADD CONSTRAINT "FK_29f5be1631fdc08ce2ad6a9c034" FOREIGN KEY ("tenantId") REFERENCES "auth"."tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."announcement_acknowledgments" ADD CONSTRAINT "FK_5b31e3f30a25937e045cfba3d6d" FOREIGN KEY ("announcementId") REFERENCES "auth"."announcements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "auth"."refresh_tokens" ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

        // ── Faz 3.5 hand-author addition — audit immutability triggers ──
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "auth".audit_logs_prevent_update_or_delete()
            RETURNS trigger AS $auditguard$
            BEGIN
              RAISE EXCEPTION 'Audit table "auth"."audit_logs" is append-only; UPDATE/DELETE refused (Faz 1.4 protected-tables-guard).';
            END;
            $auditguard$ LANGUAGE plpgsql;
        `);
        await queryRunner.query(`
            CREATE TRIGGER trg_audit_logs_prevent_update
            BEFORE UPDATE OR DELETE ON "auth"."audit_logs"
            FOR EACH ROW EXECUTE FUNCTION "auth".audit_logs_prevent_update_or_delete();
        `);
        await queryRunner.query(`
            REVOKE UPDATE, DELETE ON "auth"."audit_logs" FROM PUBLIC;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse Faz 3.5 audit immutability triggers
        await queryRunner.query(`DROP TRIGGER IF EXISTS trg_audit_logs_prevent_update ON "auth"."audit_logs";`);
        await queryRunner.query(`DROP FUNCTION IF EXISTS "auth".audit_logs_prevent_update_or_delete();`);
        await queryRunner.query(`ALTER TABLE "auth"."refresh_tokens" DROP CONSTRAINT "FK_610102b60fea1455310ccd299de"`);
        await queryRunner.query(`ALTER TABLE "auth"."announcement_acknowledgments" DROP CONSTRAINT "FK_5b31e3f30a25937e045cfba3d6d"`);
        await queryRunner.query(`ALTER TABLE "auth"."announcements" DROP CONSTRAINT "FK_29f5be1631fdc08ce2ad6a9c034"`);
        await queryRunner.query(`ALTER TABLE "auth"."user_module_assignments" DROP CONSTRAINT "FK_5d42a5b70f4506a9c29fb3bd225"`);
        await queryRunner.query(`ALTER TABLE "auth"."user_module_assignments" DROP CONSTRAINT "FK_cdec674320f153ecf8e842cd443"`);
        await queryRunner.query(`ALTER TABLE "auth"."webauthn_credentials" DROP CONSTRAINT "FK_4e5d1a5131f49fdbc410b8ded04"`);
        await queryRunner.query(`ALTER TABLE "auth"."messages" DROP CONSTRAINT "FK_15f9bd2bf472ff12b6ee20012d0"`);
        await queryRunner.query(`ALTER TABLE "auth"."message_threads" DROP CONSTRAINT "FK_8bccdf9b34dc6b06fc2636856f4"`);
        await queryRunner.query(`ALTER TABLE "auth"."ticket_comments" DROP CONSTRAINT "FK_f6beba8ae36e1ce20968d7a3192"`);
        await queryRunner.query(`ALTER TABLE "auth"."support_tickets" DROP CONSTRAINT "FK_7f39d4242941c82c75c939c7e0c"`);
        await queryRunner.query(`ALTER TABLE "auth"."tenant_modules" DROP CONSTRAINT "FK_a001196031d22c837d0e45c450e"`);
        await queryRunner.query(`ALTER TABLE "auth"."tenant_modules" DROP CONSTRAINT "FK_54b5bb2fadb6ada4fe57a9e2701"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_refresh_tokens_user_revoked"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_refresh_tokens_token"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_refresh_tokens_expires"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_refresh_tokens_tenant"`);
        await queryRunner.query(`DROP TABLE "auth"."refresh_tokens"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_28c0b4b7a87307b8e2aa7573af"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_81a16611785f2db0c09b6250ba"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_ba4b92cd3ce9d8fe5fc560661d"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_5b31e3f30a25937e045cfba3d6"`);
        await queryRunner.query(`DROP TABLE "auth"."announcement_acknowledgments"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_6f68011926b37a4b428850b85a"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_5f0c9af38fdf3318a0294dfb74"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_0fabf411618aba4c3c7790fd31"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_29f5be1631fdc08ce2ad6a9c03"`);
        await queryRunner.query(`DROP TABLE "auth"."announcements"`);
        await queryRunner.query(`DROP TYPE "auth"."announcements_scope_enum"`);
        await queryRunner.query(`DROP TYPE "auth"."announcements_status_enum"`);
        await queryRunner.query(`DROP TYPE "auth"."announcements_type_enum"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_invitations_token"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_invitations_email"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_invitations_tenant"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_invitations_status"`);
        await queryRunner.query(`DROP TABLE "auth"."invitations"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_user_module_assignments_user"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_user_module_assignments_module"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_user_module_assignments_tenant"`);
        await queryRunner.query(`DROP TABLE "auth"."user_module_assignments"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_webauthn_user"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_webauthn_credential_id"`);
        await queryRunner.query(`DROP TABLE "auth"."webauthn_credentials"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_users_tenant"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_users_role"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_users_invitation_token"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_users_password_reset_token"`);
        await queryRunner.query(`DROP TABLE "auth"."users"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_37e3e110ca0d8b7a51ef50f256"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_15f9bd2bf472ff12b6ee20012d"`);
        await queryRunner.query(`DROP TABLE "auth"."messages"`);
        await queryRunner.query(`DROP TYPE "auth"."messages_status_enum"`);
        await queryRunner.query(`DROP TYPE "auth"."messages_sendertype_enum"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_4b26c662365bb483150f26e4a9"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_5dffedd696eda85e924dc3f1e8"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_8bccdf9b34dc6b06fc2636856f"`);
        await queryRunner.query(`DROP TABLE "auth"."message_threads"`);
        await queryRunner.query(`DROP TYPE "auth"."message_threads_status_enum"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_61d6c935d0da6b5a918d5e58cd"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_f6beba8ae36e1ce20968d7a319"`);
        await queryRunner.query(`DROP TABLE "auth"."ticket_comments"`);
        await queryRunner.query(`DROP TYPE "auth"."ticket_comments_authortype_enum"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_e0936f43c38a118dbabd50297e"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_58d3701b67654aa893d1d093f6"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_11d8635c21eeba3de3e8769424"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_7f39d4242941c82c75c939c7e0"`);
        await queryRunner.query(`DROP TABLE "auth"."support_tickets"`);
        await queryRunner.query(`DROP TYPE "auth"."support_tickets_status_enum"`);
        await queryRunner.query(`DROP TYPE "auth"."support_tickets_priority_enum"`);
        await queryRunner.query(`DROP TYPE "auth"."support_tickets_category_enum"`);
        await queryRunner.query(`DROP TABLE "auth"."mobile_user_settings"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_tenant_modules_tenant"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_tenant_modules_module"`);
        await queryRunner.query(`DROP TABLE "auth"."tenant_modules"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_modules_code"`);
        await queryRunner.query(`DROP TABLE "auth"."modules"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_tenants_slug"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_tenants_status"`);
        await queryRunner.query(`DROP INDEX "auth"."UQ_tenants_customDomain"`);
        await queryRunner.query(`DROP TABLE "auth"."tenants"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_audit_tenant_created"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_audit_performer_tenant"`);
        await queryRunner.query(`DROP INDEX "auth"."IDX_audit_entity"`);
        await queryRunner.query(`DROP TABLE "auth"."audit_logs"`);
        await queryRunner.query(`DROP TYPE "auth"."audit_logs_severity_enum"`);
    }

}
