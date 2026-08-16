import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the bounded, immutable idempotency ledger used by the gateway's
 * exact-operation impersonation authorization protocol.
 */
export class CreateImpersonationAuthorizationReceipts1808700000000 implements MigrationInterface {
  name = 'CreateImpersonationAuthorizationReceipts1808700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "admin"."impersonation_authorization_receipts" (
        "sessionId" uuid NOT NULL,
        "authorizationReceiptId" uuid NOT NULL,
        "requestDigest" char(64) NOT NULL,
        "actorId" uuid NOT NULL,
        "effectiveTenantId" uuid NOT NULL,
        "method" varchar(10) NOT NULL,
        "normalizedPath" varchar(2048) NOT NULL,
        "normalizedQueryHash" char(64) NOT NULL,
        "bodyHash" char(64) NOT NULL,
        "clientIp" inet NOT NULL,
        "clientUserAgentHash" char(64) NOT NULL,
        "sessionGeneration" char(64) NOT NULL,
        "permissionGeneration" char(64) NOT NULL,
        "recordedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_impersonation_authorization_receipts"
          PRIMARY KEY ("sessionId", "authorizationReceiptId"),
        CONSTRAINT "FK_impersonation_authorization_receipts_session"
          FOREIGN KEY ("sessionId")
          REFERENCES "admin"."impersonation_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_impersonation_authorization_receipt_hashes" CHECK (
          "requestDigest" ~ '^[0-9a-f]{64}$' AND
          "normalizedQueryHash" ~ '^[0-9a-f]{64}$' AND
          "bodyHash" ~ '^[0-9a-f]{64}$' AND
          "clientUserAgentHash" ~ '^[0-9a-f]{64}$' AND
          "sessionGeneration" ~ '^[0-9a-f]{64}$' AND
          "permissionGeneration" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_impersonation_authorization_receipt_method" CHECK (
          "method" IN ('DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT')
        ),
        CONSTRAINT "CHK_impersonation_authorization_receipt_path" CHECK (
          "normalizedPath" ~ '^/[^[:space:][:cntrl:]?#\\\\]*$' AND
          "normalizedPath" NOT LIKE '%//%' AND
          strpos("normalizedPath", E'\\\\') = 0 AND
          ("normalizedPath" = '/' OR right("normalizedPath", 1) <> '/')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_impersonation_authorization_receipts_actor_recorded"
      ON "admin"."impersonation_authorization_receipts" ("actorId", "recordedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_impersonation_authorization_receipts_tenant_recorded"
      ON "admin"."impersonation_authorization_receipts" ("effectiveTenantId", "recordedAt")
    `);

    await queryRunner.query(`
      CREATE TABLE "admin"."impersonation_authorization_operation_receipts" (
        "sessionId" uuid NOT NULL,
        "authorizationReceiptId" uuid NOT NULL,
        "operationSetDigest" char(64) NOT NULL,
        "operations" jsonb NOT NULL,
        "operationCount" smallint NOT NULL,
        "decision" varchar(16) NOT NULL,
        "denialReason" varchar(100),
        "sessionGeneration" char(64) NOT NULL,
        "permissionGeneration" char(64) NOT NULL,
        "recordedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_impersonation_authorization_operation_receipts"
          PRIMARY KEY ("sessionId", "authorizationReceiptId", "operationSetDigest"),
        CONSTRAINT "FK_impersonation_authorization_operation_receipts_parent"
          FOREIGN KEY ("sessionId", "authorizationReceiptId")
          REFERENCES "admin"."impersonation_authorization_receipts"
            ("sessionId", "authorizationReceiptId") ON DELETE CASCADE,
        CONSTRAINT "CHK_impersonation_authorization_operation_receipt_hashes" CHECK (
          "operationSetDigest" ~ '^[0-9a-f]{64}$' AND
          "sessionGeneration" ~ '^[0-9a-f]{64}$' AND
          "permissionGeneration" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_impersonation_authorization_operation_receipt_count" CHECK (
          jsonb_typeof("operations") = 'array' AND
          "operationCount" BETWEEN 1 AND 128 AND
          jsonb_array_length("operations") = "operationCount"
        ),
        CONSTRAINT "CHK_impersonation_authorization_operation_receipt_decision" CHECK (
          ("decision" = 'authorized' AND "denialReason" IS NULL) OR
          ("decision" = 'denied' AND "denialReason" IS NOT NULL AND
            "denialReason" = btrim("denialReason") AND "denialReason" <> '')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_impersonation_authorization_operation_decision_recorded"
      ON "admin"."impersonation_authorization_operation_receipts"
        ("decision", "recordedAt")
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_authorization_receipt_insert_guard()
      RETURNS trigger AS $receipt_insert_guard$
      DECLARE
        session_status varchar;
        session_actor uuid;
        session_tenant uuid;
      BEGIN
        SELECT "status", "superAdminId", "targetTenantId"
        INTO session_status, session_actor, session_tenant
        FROM "admin"."impersonation_sessions"
        WHERE "id" = NEW."sessionId"
        FOR UPDATE;

        IF NOT FOUND OR session_status <> 'active' THEN
          RAISE EXCEPTION 'authorization receipts require an active impersonation session';
        END IF;
        IF session_actor <> NEW."actorId" OR session_tenant <> NEW."effectiveTenantId" THEN
          RAISE EXCEPTION 'authorization receipt actor or tenant binding diverged';
        END IF;
        IF (
          SELECT count(*)
          FROM "admin"."impersonation_authorization_receipts"
          WHERE "sessionId" = NEW."sessionId"
        ) >= 10000 THEN
          RAISE EXCEPTION 'impersonation authorization receipt capacity exhausted';
        END IF;
        RETURN NEW;
      END;
      $receipt_insert_guard$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_impersonation_authorization_receipt_insert_guard"
      BEFORE INSERT ON "admin"."impersonation_authorization_receipts"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_authorization_receipt_insert_guard()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_authorization_operation_insert_guard()
      RETURNS trigger AS $operation_insert_guard$
      DECLARE
        session_status varchar;
        parent_session_generation char(64);
        parent_permission_generation char(64);
        operation_member jsonb;
      BEGIN
        SELECT "status"
        INTO session_status
        FROM "admin"."impersonation_sessions"
        WHERE "id" = NEW."sessionId"
        FOR UPDATE;
        IF NOT FOUND OR session_status <> 'active' THEN
          RAISE EXCEPTION 'operation receipts require an active impersonation session';
        END IF;

        SELECT "sessionGeneration", "permissionGeneration"
        INTO parent_session_generation, parent_permission_generation
        FROM "admin"."impersonation_authorization_receipts"
        WHERE "sessionId" = NEW."sessionId"
          AND "authorizationReceiptId" = NEW."authorizationReceiptId";
        IF NOT FOUND OR
          parent_session_generation <> NEW."sessionGeneration" OR
          parent_permission_generation <> NEW."permissionGeneration" THEN
          RAISE EXCEPTION 'operation receipt generation diverged from its parent';
        END IF;

        IF (
          SELECT count(*)
          FROM "admin"."impersonation_authorization_operation_receipts"
          WHERE "sessionId" = NEW."sessionId"
        ) >= 25000 THEN
          RAISE EXCEPTION 'impersonation operation receipt capacity exhausted';
        END IF;

        FOR operation_member IN SELECT value FROM jsonb_array_elements(NEW."operations")
        LOOP
          IF jsonb_typeof(operation_member) <> 'object' OR
            (SELECT count(*) FROM jsonb_object_keys(operation_member)) <> 3 OR
            jsonb_typeof(operation_member -> 'authority') <> 'string' OR
            jsonb_typeof(operation_member -> 'module') <> 'string' OR
            jsonb_typeof(operation_member -> 'operation') <> 'string' OR
            operation_member ->> 'authority' NOT IN (
              'data.read', 'data.write', 'billing.read', 'billing.write',
              'users.read', 'users.write', 'settings.read', 'settings.write', 'export'
            ) OR
            operation_member ->> 'module' NOT IN (
              'auth', 'farm', 'sensor', 'hr', 'hydroponics', 'messaging',
              'alert', 'billing', 'notification', 'config', 'ai'
            ) OR
            length(operation_member ->> 'operation') NOT BETWEEN 1 AND 2048 OR
            operation_member ->> 'operation' <> btrim(operation_member ->> 'operation') OR
            operation_member ->> 'operation' ~ '[[:cntrl:]]' THEN
            RAISE EXCEPTION 'operation receipt contains a non-canonical descriptor';
          END IF;
        END LOOP;

        IF EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW."operations") AS candidate
          GROUP BY candidate ->> 'module', candidate ->> 'operation'
          HAVING count(*) <> 1
        ) THEN
          RAISE EXCEPTION 'operation receipt contains duplicate operation coordinates';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM (
            SELECT operation_key,
              lag(operation_key) OVER (ORDER BY ordinal) AS prior_operation_key
            FROM (
              SELECT ordinal,
                (
                  (value ->> 'authority') || U&'\\001F' ||
                  (value ->> 'module') || U&'\\001F' ||
                  (value ->> 'operation')
                ) COLLATE "C" AS operation_key
              FROM jsonb_array_elements(NEW."operations") WITH ORDINALITY
                AS operation_member(value, ordinal)
            ) canonical_keys
          ) ordered_operations
          WHERE prior_operation_key IS NOT NULL
            AND prior_operation_key >= operation_key
        ) THEN
          RAISE EXCEPTION 'operation receipt array is not in canonical order';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM "admin"."impersonation_authorization_operation_receipts" sibling
          CROSS JOIN LATERAL jsonb_array_elements(sibling."operations") AS prior
          CROSS JOIN LATERAL jsonb_array_elements(NEW."operations") AS candidate
          WHERE sibling."sessionId" = NEW."sessionId"
            AND sibling."authorizationReceiptId" = NEW."authorizationReceiptId"
            AND prior ->> 'module' = candidate ->> 'module'
            AND prior ->> 'operation' = candidate ->> 'operation'
        ) THEN
          RAISE EXCEPTION 'operation receipt overlaps a sibling operation set';
        END IF;
        RETURN NEW;
      END;
      $operation_insert_guard$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_impersonation_authorization_operation_insert_guard"
      BEFORE INSERT ON "admin"."impersonation_authorization_operation_receipts"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_authorization_operation_insert_guard()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_authorization_prevent_update()
      RETURNS trigger AS $receipt_immutable$
      BEGIN
        RAISE EXCEPTION 'impersonation authorization receipt rows are immutable';
      END;
      $receipt_immutable$ LANGUAGE plpgsql;
    `);
    for (const table of [
      'impersonation_authorization_receipts',
      'impersonation_authorization_operation_receipts',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER "TRG_${table}_prevent_update"
        BEFORE UPDATE ON "admin"."${table}"
        FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_authorization_prevent_update()
      `);
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_authorization_terminal_delete_guard()
      RETURNS trigger AS $receipt_terminal_delete$
      DECLARE
        session_status varchar;
      BEGIN
        SELECT "status" INTO session_status
        FROM "admin"."impersonation_sessions"
        WHERE "id" = OLD."sessionId";
        IF session_status IS NULL OR session_status = 'active' THEN
          RAISE EXCEPTION 'authorization receipts can only be retired for terminal sessions';
        END IF;
        RETURN OLD;
      END;
      $receipt_terminal_delete$ LANGUAGE plpgsql;
    `);
    for (const table of [
      'impersonation_authorization_receipts',
      'impersonation_authorization_operation_receipts',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER "TRG_${table}_terminal_delete_guard"
        BEFORE DELETE ON "admin"."${table}"
        FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_authorization_terminal_delete_guard()
      `);
    }

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".retire_impersonation_authorization_receipts(
        target_session_id uuid
      ) RETURNS bigint
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $retire_receipts$
      DECLARE
        session_status varchar;
        retired_count bigint;
      BEGIN
        SELECT "status" INTO session_status
        FROM admin.impersonation_sessions
        WHERE "id" = target_session_id
        FOR UPDATE;
        IF NOT FOUND OR session_status = 'active' THEN
          RAISE EXCEPTION 'receipt retirement requires a terminal impersonation session';
        END IF;
        DELETE FROM admin.impersonation_authorization_receipts
        WHERE "sessionId" = target_session_id;
        GET DIAGNOSTICS retired_count = ROW_COUNT;
        RETURN retired_count;
      END;
      $retire_receipts$;
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION "admin".retire_impersonation_authorization_receipts(uuid)
      FROM PUBLIC
    `);
    await queryRunner.query(`
      REVOKE UPDATE, DELETE ON TABLE
        "admin"."impersonation_authorization_receipts",
        "admin"."impersonation_authorization_operation_receipts"
      FROM PUBLIC
    `);
    await queryRunner.query(`
      DO $receipt_grants$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') THEN
          EXECUTE 'GRANT SELECT, INSERT ON TABLE ' ||
            'admin.impersonation_authorization_receipts, ' ||
            'admin.impersonation_authorization_operation_receipts TO admin_service';
          EXECUTE 'REVOKE UPDATE, DELETE ON TABLE ' ||
            'admin.impersonation_authorization_receipts, ' ||
            'admin.impersonation_authorization_operation_receipts FROM admin_service';
          EXECUTE 'GRANT EXECUTE ON FUNCTION ' ||
            'admin.retire_impersonation_authorization_receipts(uuid) TO admin_service';
        END IF;
      END;
      $receipt_grants$;
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'CreateImpersonationAuthorizationReceipts1808700000000 is forward-only: ' +
        'dropping immutable authorization evidence would reopen replay ambiguity',
    );
  }
}
