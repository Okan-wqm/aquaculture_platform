import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the unused plaintext originalSessionToken and makes the sole live
 * impersonation credential a database-enforced active-session invariant.
 */
export class RetireImpersonationDeadSecretAndConstrainCredential1808600000000
  implements MigrationInterface
{
  name = 'RetireImpersonationDeadSecretAndConstrainCredential1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_impersonation_sessions_enforce_lifecycle
      ON "admin"."impersonation_sessions"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "admin".impersonation_sessions_enforce_lifecycle()
    `);

    // Legacy ACTIVE rows without every credential binding required by the new
    // authority are terminated and paired with an immutable admin audit row in
    // the same SQL statement. Metadata is supplemental evidence, never the
    // required audit authority.
    await queryRunner.query(`
      WITH terminated AS (
        UPDATE "admin"."impersonation_sessions"
        SET
          "status" = 'terminated',
          "endedAt" = COALESCE("endedAt", clock_timestamp()),
          "endReason" = 'Terminated by security invariant migration: invalid active credential binding',
          "impersonationToken" = NULL,
          "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
            'credentialInvariantMigration',
            jsonb_build_object(
              'policy', 'terminate_invalid_legacy_active_security_row',
              'migration', '1808600000000',
              'recordedAt', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          ),
          "updatedAt" = clock_timestamp()
        WHERE "status" = 'active'
          AND (
            "impersonationToken" IS NULL
            OR "impersonationToken" !~ '^[0-9a-f]{64}$'
            OR "ipAddress" IS NULL
            OR "userAgent" IS NULL
            OR "userAgent" = ''
            OR "userAgent" <> btrim("userAgent")
            OR length("userAgent") > 1024
            OR "userAgent" ~ '[[:cntrl:]]'
            OR "mfaCompleted" IS DISTINCT FROM true
            OR "endedAt" IS NOT NULL
          )
        RETURNING "id", "targetTenantId", "superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "tenantId", "performedBy",
        "details", "severity", "sessionId"
      )
      SELECT
        'IMPERSONATION_TERMINATED_BY_SECURITY_MIGRATION',
        'ImpersonationSession',
        terminated."id",
        terminated."targetTenantId",
        'migration:1808600000000',
        jsonb_build_object(
          'sessionId', terminated."id",
          'sessionOwnerId', terminated."superAdminId",
          'policy', 'terminate_invalid_legacy_active_security_row',
          'migration', '1808600000000'
        ),
        'critical',
        terminated."id"::text
      FROM terminated
    `);

    // A legacy deployment could have admitted duplicate valid hashes before
    // the partial uniqueness authority existed. Keep the oldest row as the
    // sole active credential and terminate every later duplicate with a
    // deterministic, retained migration disposition.
    await queryRunner.query(`
      WITH ranked_active_credentials AS (
        SELECT
          "id",
          row_number() OVER (
            PARTITION BY "impersonationToken"
            ORDER BY "createdAt" ASC, "id" ASC
          ) AS credential_rank
        FROM "admin"."impersonation_sessions"
        WHERE "status" = 'active'
          AND "impersonationToken" ~ '^[0-9a-f]{64}$'
      ), terminated AS (
        UPDATE "admin"."impersonation_sessions" AS session
        SET
          "status" = 'terminated',
          "endedAt" = COALESCE(session."endedAt", clock_timestamp()),
          "endReason" = 'Terminated by credential invariant migration: duplicate active token hash',
          "impersonationToken" = NULL,
          "metadata" = COALESCE(session."metadata", '{}'::jsonb) || jsonb_build_object(
            'credentialInvariantMigration',
            jsonb_build_object(
              'policy', 'terminate_duplicate_legacy_active_row',
              'migration', '1808600000000',
              'recordedAt', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          ),
          "updatedAt" = clock_timestamp()
        FROM ranked_active_credentials AS ranked
        WHERE session."id" = ranked."id"
          AND ranked.credential_rank > 1
        RETURNING session."id", session."targetTenantId", session."superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "tenantId", "performedBy",
        "details", "severity", "sessionId"
      )
      SELECT
        'IMPERSONATION_TERMINATED_BY_SECURITY_MIGRATION',
        'ImpersonationSession',
        terminated."id",
        terminated."targetTenantId",
        'migration:1808600000000',
        jsonb_build_object(
          'sessionId', terminated."id",
          'sessionOwnerId', terminated."superAdminId",
          'policy', 'terminate_duplicate_legacy_active_row',
          'migration', '1808600000000'
        ),
        'critical',
        terminated."id"::text
      FROM terminated
    `);

    await queryRunner.query(`
      WITH repaired AS (
        UPDATE "admin"."impersonation_sessions"
        SET
          "status" = CASE
            WHEN "status" IN ('ended', 'expired', 'terminated') THEN "status"
            ELSE 'terminated'
          END,
          "endedAt" = COALESCE("endedAt", clock_timestamp()),
          "endReason" = COALESCE(
            "endReason",
            'Normalized by impersonation lifecycle migration'
          ),
          "impersonationToken" = NULL,
          "updatedAt" = clock_timestamp()
        WHERE "status" NOT IN ('active', 'ended', 'expired', 'terminated')
           OR ("status" <> 'active' AND "endedAt" IS NULL)
        RETURNING "id", "targetTenantId", "superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "tenantId", "performedBy",
        "details", "severity", "sessionId"
      )
      SELECT
        'IMPERSONATION_LIFECYCLE_REPAIRED_BY_MIGRATION',
        'ImpersonationSession',
        repaired."id",
        repaired."targetTenantId",
        'migration:1808600000000',
        jsonb_build_object(
          'sessionId', repaired."id",
          'sessionOwnerId', repaired."superAdminId",
          'policy', 'normalize_legacy_terminal_lifecycle',
          'migration', '1808600000000'
        ),
        'critical',
        repaired."id"::text
      FROM repaired
    `);

    // Terminal rows retain forensic state but never retain a reusable
    // credential hash. Record every legacy scrub as durable audit evidence.
    await queryRunner.query(`
      WITH scrubbed AS (
        UPDATE "admin"."impersonation_sessions"
        SET "impersonationToken" = NULL, "updatedAt" = clock_timestamp()
        WHERE "status" <> 'active' AND "impersonationToken" IS NOT NULL
        RETURNING "id", "targetTenantId", "superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "tenantId", "performedBy",
        "details", "severity", "sessionId"
      )
      SELECT
        'IMPERSONATION_TERMINAL_CREDENTIAL_SCRUBBED_BY_MIGRATION',
        'ImpersonationSession',
        scrubbed."id",
        scrubbed."targetTenantId",
        'migration:1808600000000',
        jsonb_build_object(
          'sessionId', scrubbed."id",
          'sessionOwnerId', scrubbed."superAdminId",
          'policy', 'scrub_terminal_credential_hash',
          'migration', '1808600000000'
        ),
        'critical',
        scrubbed."id"::text
      FROM scrubbed
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_sessions"
      DROP COLUMN IF EXISTS "originalSessionToken"
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".is_canonical_uuid_jsonb_array(value jsonb)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $canonical_uuid_array$
        SELECT CASE
          WHEN jsonb_typeof(value) <> 'array' THEN false
          ELSE
            NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(value) AS element(item)
              WHERE element.item !~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
            AND jsonb_array_length(value) = (
              SELECT count(DISTINCT element.item)
              FROM jsonb_array_elements_text(value) AS element(item)
            )
            AND value = COALESCE(
              (
                SELECT jsonb_agg(to_jsonb(element.item) ORDER BY element.item)
                FROM jsonb_array_elements_text(value) AS element(item)
              ),
              '[]'::jsonb
            )
        END
      $canonical_uuid_array$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".uuid_jsonb_arrays_disjoint(
        left_value jsonb,
        right_value jsonb
      )
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      AS $uuid_arrays_disjoint$
        SELECT CASE
          WHEN left_value IS NOT NULL AND jsonb_typeof(left_value) <> 'array' THEN false
          WHEN right_value IS NOT NULL AND jsonb_typeof(right_value) <> 'array' THEN false
          ELSE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(left_value, '[]'::jsonb)) AS left_item(value)
            JOIN jsonb_array_elements_text(COALESCE(right_value, '[]'::jsonb)) AS right_item(value)
              ON left_item.value = right_item.value
          )
        END
      $uuid_arrays_disjoint$
    `);

    // The model has exactly one durable permission row per super-admin. When
    // legacy duplicates exist, retain the oldest row, deactivate it fail-closed,
    // audit that disposition, audit every removed duplicate, then add the DB
    // uniqueness authority.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          "superAdminId",
          row_number() OVER (
            PARTITION BY "superAdminId"
            ORDER BY "createdAt" ASC, "id" ASC
          ) AS permission_rank,
          count(*) OVER (PARTITION BY "superAdminId") AS permission_count
        FROM "admin"."impersonation_permissions"
      ), deactivated AS (
        UPDATE "admin"."impersonation_permissions" AS permission
        SET
          "isActive" = false,
          "canImpersonate" = false,
          "notifyTenantAdmin" = false,
          "updatedAt" = clock_timestamp()
        FROM ranked
        WHERE permission."id" = ranked."id"
          AND ranked.permission_rank = 1
          AND ranked.permission_count > 1
        RETURNING permission."id", permission."superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "performedBy", "details", "severity"
      )
      SELECT
        'IMPERSONATION_DUPLICATE_PERMISSION_CANONICALIZED_BY_MIGRATION',
        'ImpersonationPermission',
        deactivated."id",
        'migration:1808600000000',
        jsonb_build_object(
          'superAdminId', deactivated."superAdminId",
          'policy', 'retain_oldest_and_deactivate_duplicate_group',
          'migration', '1808600000000'
        ),
        'critical'
      FROM deactivated
    `);
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          "id",
          "superAdminId",
          row_number() OVER (
            PARTITION BY "superAdminId"
            ORDER BY "createdAt" ASC, "id" ASC
          ) AS permission_rank
        FROM "admin"."impersonation_permissions"
      ), audited AS (
        INSERT INTO "admin"."audit_logs" (
          "action", "entityType", "entityId", "performedBy", "details", "severity"
        )
        SELECT
          'IMPERSONATION_DUPLICATE_PERMISSION_REMOVED_BY_MIGRATION',
          'ImpersonationPermission',
          ranked."id",
          'migration:1808600000000',
          jsonb_build_object(
            'superAdminId', ranked."superAdminId",
            'policy', 'remove_noncanonical_duplicate_permission_row',
            'migration', '1808600000000'
          ),
          'critical'
        FROM ranked
        WHERE ranked.permission_rank > 1
        RETURNING "entityId"
      )
      DELETE FROM "admin"."impersonation_permissions" AS permission
      USING audited
      WHERE permission."id" = audited."entityId"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_impersonation_permission_super_admin"
      ON "admin"."impersonation_permissions" ("superAdminId")
    `);

    // Tenant-admin recipient resolution is not implemented by the canonical
    // notification authority. Normalize the legacy flag to the only supported
    // state with a durable per-row audit disposition, then make false a DB
    // invariant until a future outbox+recipient-resolution migration replaces it.
    await queryRunner.query(`
      WITH normalized AS (
        UPDATE "admin"."impersonation_permissions"
        SET "notifyTenantAdmin" = false, "updatedAt" = clock_timestamp()
        WHERE "notifyTenantAdmin" = true
        RETURNING "id", "superAdminId"
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "performedBy", "details", "severity"
      )
      SELECT
        'IMPERSONATION_UNSUPPORTED_NOTIFICATION_DISABLED_BY_MIGRATION',
        'ImpersonationPermission',
        normalized."id",
        'migration:1808600000000',
        jsonb_build_object(
          'superAdminId', normalized."superAdminId",
          'policy', 'disable_until_canonical_recipient_resolution_exists',
          'migration', '1808600000000'
        ),
        'critical'
      FROM normalized
    `);

    // Invalid legacy tenant scopes are not repaired speculatively. Deactivate
    // them so an administrator must re-grant an explicit canonical scope.
    await queryRunner.query(`
      WITH candidates AS (
        SELECT "id", "allowedTenants", "restrictedTenants"
        FROM "admin"."impersonation_permissions"
        WHERE
          "allowedTenants" IS NULL
          OR NOT "admin".is_canonical_uuid_jsonb_array("allowedTenants")
          OR CASE
            WHEN jsonb_typeof("allowedTenants") = 'array'
              THEN jsonb_array_length("allowedTenants") = 0
            ELSE false
          END
          OR (
            "restrictedTenants" IS NOT NULL
            AND NOT "admin".is_canonical_uuid_jsonb_array("restrictedTenants")
          )
          OR NOT "admin".uuid_jsonb_arrays_disjoint(
            "allowedTenants",
            "restrictedTenants"
          )
      ), deactivated AS (
        UPDATE "admin"."impersonation_permissions" AS permission
        SET
          "isActive" = false,
          "canImpersonate" = false,
          "allowedTenants" = NULL,
          "restrictedTenants" = NULL,
          "updatedAt" = clock_timestamp()
        FROM candidates
        WHERE permission."id" = candidates."id"
        RETURNING
          permission."id",
          permission."superAdminId",
          candidates."allowedTenants" AS old_allowed_tenants,
          candidates."restrictedTenants" AS old_restricted_tenants
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "performedBy", "details", "severity"
      )
      SELECT
        'IMPERSONATION_INVALID_TENANT_SCOPE_DEACTIVATED_BY_MIGRATION',
        'ImpersonationPermission',
        deactivated."id",
        'migration:1808600000000',
        jsonb_build_object(
          'superAdminId', deactivated."superAdminId",
          'policy', 'deactivate_invalid_legacy_tenant_scope',
          'migration', '1808600000000',
          'oldAllowedTenants', deactivated.old_allowed_tenants,
          'oldRestrictedTenants', deactivated.old_restricted_tenants
        ),
        'critical'
      FROM deactivated
    `);

    // Normalize legacy out-of-range grant limits once, with previous/new
    // values preserved in the mandatory migration audit row, before the DB
    // CHECK authority becomes active.
    await queryRunner.query(`
      WITH candidates AS (
        SELECT
          "id",
          "superAdminId",
          "maxSessionDurationMinutes" AS old_duration,
          "maxConcurrentSessions" AS old_concurrency
        FROM "admin"."impersonation_permissions"
        WHERE "maxSessionDurationMinutes" NOT BETWEEN 1 AND 60
           OR "maxConcurrentSessions" NOT BETWEEN 1 AND 10
      ), repaired AS (
        UPDATE "admin"."impersonation_permissions" AS permission
        SET
          "maxSessionDurationMinutes" = LEAST(
            GREATEST(permission."maxSessionDurationMinutes", 1),
            60
          ),
          "maxConcurrentSessions" = LEAST(
            GREATEST(permission."maxConcurrentSessions", 1),
            10
          ),
          "updatedAt" = clock_timestamp()
        FROM candidates
        WHERE permission."id" = candidates."id"
        RETURNING
          permission."id",
          permission."superAdminId",
          permission."maxSessionDurationMinutes" AS new_duration,
          permission."maxConcurrentSessions" AS new_concurrency,
          candidates.old_duration,
          candidates.old_concurrency
      )
      INSERT INTO "admin"."audit_logs" (
        "action", "entityType", "entityId", "performedBy", "details", "severity"
      )
      SELECT
        'IMPERSONATION_PERMISSION_LIMIT_REPAIRED_BY_MIGRATION',
        'ImpersonationPermission',
        repaired."id",
        'migration:1808600000000',
        jsonb_build_object(
          'superAdminId', repaired."superAdminId",
          'migration', '1808600000000',
          'oldMaxSessionDurationMinutes', repaired.old_duration,
          'newMaxSessionDurationMinutes', repaired.new_duration,
          'oldMaxConcurrentSessions', repaired.old_concurrency,
          'newMaxConcurrentSessions', repaired.new_concurrency
        ),
        'critical'
      FROM repaired
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ADD CONSTRAINT "CHK_impersonation_permission_duration"
      CHECK ("maxSessionDurationMinutes" BETWEEN 1 AND 60) NOT VALID,
      ADD CONSTRAINT "CHK_impersonation_permission_concurrency"
      CHECK ("maxConcurrentSessions" BETWEEN 1 AND 10) NOT VALID,
      ADD CONSTRAINT "CHK_impersonation_permission_tenant_scope_shape"
      CHECK (
        ("allowedTenants" IS NULL OR "admin".is_canonical_uuid_jsonb_array("allowedTenants"))
        AND (
          "restrictedTenants" IS NULL
          OR "admin".is_canonical_uuid_jsonb_array("restrictedTenants")
        )
        AND "admin".uuid_jsonb_arrays_disjoint("allowedTenants", "restrictedTenants")
      ) NOT VALID,
      ADD CONSTRAINT "CHK_impersonation_permission_active_scope"
      CHECK (
        NOT ("isActive" AND "canImpersonate")
        OR CASE
          WHEN jsonb_typeof("allowedTenants") = 'array'
            THEN jsonb_array_length("allowedTenants") > 0
          ELSE false
        END
      ) NOT VALID,
      ADD CONSTRAINT "CHK_impersonation_permission_notification_supported"
      CHECK ("notifyTenantAdmin" = false) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      VALIDATE CONSTRAINT "CHK_impersonation_permission_duration",
      VALIDATE CONSTRAINT "CHK_impersonation_permission_concurrency",
      VALIDATE CONSTRAINT "CHK_impersonation_permission_tenant_scope_shape",
      VALIDATE CONSTRAINT "CHK_impersonation_permission_active_scope",
      VALIDATE CONSTRAINT "CHK_impersonation_permission_notification_supported"
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_permissions"
      ALTER COLUMN "notifyTenantAdmin" SET DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_sessions"
      ADD CONSTRAINT "CHK_impersonation_session_credential_lifecycle"
      CHECK (
        (
          "status" = 'active'
          AND
          "impersonationToken" IS NOT NULL
          AND "impersonationToken" ~ '^[0-9a-f]{64}$'
          AND "ipAddress" IS NOT NULL
          AND "userAgent" IS NOT NULL
          AND "userAgent" <> ''
          AND "userAgent" = btrim("userAgent")
          AND length("userAgent") <= 1024
          AND "userAgent" !~ '[[:cntrl:]]'
          AND "mfaCompleted" = true
        )
        OR (
          "status" <> 'active'
          AND "impersonationToken" IS NULL
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_sessions"
      ADD CONSTRAINT "CHK_impersonation_session_status_lifecycle"
      CHECK (
        ("status" = 'active' AND "endedAt" IS NULL)
        OR (
          "status" IN ('ended', 'expired', 'terminated')
          AND "endedAt" IS NOT NULL
        )
      ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "admin"."impersonation_sessions"
      VALIDATE CONSTRAINT "CHK_impersonation_session_credential_lifecycle",
      VALIDATE CONSTRAINT "CHK_impersonation_session_status_lifecycle"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_impersonation_active_token_hash"
      ON "admin"."impersonation_sessions" ("impersonationToken")
      WHERE "status" = 'active'
    `);

    // Replacement for the 180850 lifecycle projection. The retired plaintext
    // column is deliberately absent; the canonical credential hash is
    // immutable while ACTIVE and must be scrubbed on the terminal transition.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_sessions_enforce_lifecycle()
      RETURNS trigger AS $impersonation_lifecycle$
      BEGIN
        IF ROW(
          NEW."id", NEW."superAdminId", NEW."superAdminEmail",
          NEW."targetTenantId", NEW."targetTenantName", NEW."targetUserId",
          NEW."targetUserEmail", NEW."reason", NEW."reasonDetails",
          NEW."ticketReference", NEW."permissions", NEW."ipAddress",
          NEW."userAgent", NEW."mfaCompleted",
          NEW."metadata", NEW."createdAt"
        ) IS DISTINCT FROM ROW(
          OLD."id", OLD."superAdminId", OLD."superAdminEmail",
          OLD."targetTenantId", OLD."targetTenantName", OLD."targetUserId",
          OLD."targetUserEmail", OLD."reason", OLD."reasonDetails",
          OLD."ticketReference", OLD."permissions", OLD."ipAddress",
          OLD."userAgent", OLD."mfaCompleted",
          OLD."metadata", OLD."createdAt"
        ) THEN
          RAISE EXCEPTION 'impersonation session identity and authorization fields are immutable';
        END IF;

        IF NEW."impersonationToken" IS DISTINCT FROM OLD."impersonationToken"
          AND NOT (
            OLD."status" = 'active'
            AND NEW."status" <> 'active'
            AND NEW."impersonationToken" IS NULL
          ) THEN
          RAISE EXCEPTION 'impersonation credential hash is immutable except for terminal scrubbing';
        END IF;

        IF OLD."status" <> 'active' THEN
          RAISE EXCEPTION 'terminal impersonation sessions are immutable';
        END IF;
        IF NEW."status" NOT IN ('active', 'ended', 'expired', 'terminated') THEN
          RAISE EXCEPTION 'invalid impersonation session transition: active -> %', NEW."status";
        END IF;
        IF NEW."status" = 'active' AND NEW."endedAt" IS NOT NULL THEN
          RAISE EXCEPTION 'active impersonation session cannot have endedAt';
        END IF;
        IF NEW."status" <> 'active' AND NEW."endedAt" IS NULL THEN
          RAISE EXCEPTION 'terminal impersonation session requires endedAt';
        END IF;
        IF NEW."status" <> 'active' AND NEW."impersonationToken" IS NOT NULL THEN
          RAISE EXCEPTION 'terminal impersonation session cannot retain a credential hash';
        END IF;
        IF NEW."status" = 'active' AND NEW."expiresAt" < OLD."expiresAt" THEN
          RAISE EXCEPTION 'active impersonation expiry may only be extended';
        END IF;
        IF NEW."actionCount" < OLD."actionCount" THEN
          RAISE EXCEPTION 'impersonation actionCount is monotonic';
        END IF;

        RETURN NEW;
      END;
      $impersonation_lifecycle$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_impersonation_sessions_enforce_lifecycle
      BEFORE UPDATE ON "admin"."impersonation_sessions"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_sessions_enforce_lifecycle()
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'RetireImpersonationDeadSecretAndConstrainCredential1808600000000 is forward-only: ' +
        'the retired plaintext credential cannot be reconstructed safely',
    );
  }
}
