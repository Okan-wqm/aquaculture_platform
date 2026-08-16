import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Installs the durable two-person legal-hold release authority.
 *
 * Table names are intentionally unqualified: the platform migration runner
 * applies this migration once to the messaging source schema and once to every
 * tenant schema with a pinned search_path.
 */
export class CreateLegalHoldReleaseOperations1802200000000 implements MigrationInterface {
  name = 'CreateLegalHoldReleaseOperations1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_legal_hold_id_tenant"
      ON "legal_holds" ("id", "tenantId")
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "legal_hold_release_operations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "holdId" uuid NOT NULL,
        "status" varchar(16) NOT NULL,
        "releaseReason" text NOT NULL,
        "initiationRequestId" uuid NOT NULL,
        "initiatedBy" uuid NOT NULL,
        "initiatedAt" timestamptz NOT NULL DEFAULT now(),
        "initiatorMfaVerifiedAt" timestamptz NOT NULL,
        "initiatorTokenId" varchar(128) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "authorizationRequestId" uuid,
        "authorizedBy" uuid,
        "authorizedAt" timestamptz,
        "approverMfaVerifiedAt" timestamptz,
        "approverTokenId" varchar(128),
        "releasedAt" timestamptz,
        "expiredAt" timestamptz,
        "expiredBy" uuid,
        CONSTRAINT "pk_legal_hold_release_operations" PRIMARY KEY ("id"),
        CONSTRAINT "chk_legal_hold_release_operation_status"
          CHECK ("status" IN ('PENDING', 'RELEASED', 'EXPIRED')),
        CONSTRAINT "chk_legal_hold_release_operation_reason"
          CHECK (
            char_length(btrim("releaseReason")) >= 50
            AND char_length("releaseReason") <= 1000
          ),
        CONSTRAINT "chk_legal_hold_release_operation_token_evidence"
          CHECK (
            char_length(btrim("initiatorTokenId")) > 0
            AND (
              "approverTokenId" IS NULL
              OR char_length(btrim("approverTokenId")) > 0
            )
          ),
        CONSTRAINT "chk_legal_hold_release_operation_distinct_actors"
          CHECK ("authorizedBy" IS NULL OR "authorizedBy" <> "initiatedBy"),
        CONSTRAINT "chk_legal_hold_release_operation_state"
          CHECK (
            (
              "status" = 'PENDING'
              AND "authorizationRequestId" IS NULL
              AND "authorizedBy" IS NULL
              AND "authorizedAt" IS NULL
              AND "approverMfaVerifiedAt" IS NULL
              AND "approverTokenId" IS NULL
              AND "releasedAt" IS NULL
              AND "expiredAt" IS NULL
              AND "expiredBy" IS NULL
            ) OR (
              "status" = 'EXPIRED'
              AND "authorizationRequestId" IS NULL
              AND "authorizedBy" IS NULL
              AND "authorizedAt" IS NULL
              AND "approverMfaVerifiedAt" IS NULL
              AND "approverTokenId" IS NULL
              AND "releasedAt" IS NULL
              AND "expiredAt" IS NOT NULL
              AND "expiredBy" IS NOT NULL
            ) OR (
              "status" = 'RELEASED'
              AND "authorizationRequestId" IS NOT NULL
              AND "authorizedBy" IS NOT NULL
              AND "authorizedAt" IS NOT NULL
              AND "approverMfaVerifiedAt" IS NOT NULL
              AND "approverTokenId" IS NOT NULL
              AND "releasedAt" IS NOT NULL
              AND "expiredAt" IS NULL
              AND "expiredBy" IS NULL
            )
          ),
        CONSTRAINT "chk_legal_hold_release_operation_temporal_evidence"
          CHECK (
            "expiresAt" > "initiatedAt"
            AND "initiatorMfaVerifiedAt" >= "initiatedAt" - interval '5 minutes'
            AND "initiatorMfaVerifiedAt" <= "initiatedAt" + interval '30 seconds'
            AND (
              "authorizedAt" IS NULL
              OR (
                "approverMfaVerifiedAt" >= "authorizedAt" - interval '5 minutes'
                AND "approverMfaVerifiedAt" <= "authorizedAt" + interval '30 seconds'
                AND "releasedAt" = "authorizedAt"
              )
            )
            AND (
              "status" = 'PENDING'
              OR (
                "status" = 'EXPIRED'
                AND "expiredAt" >= "expiresAt"
              )
              OR (
                "status" = 'RELEASED'
                AND "authorizedAt" < "expiresAt"
              )
            )
          )
      )
    `);
    // CREATE TABLE LIKE INCLUDING ALL does not copy foreign keys. New tenant
    // schemas can therefore reach this migration with the table already
    // present but without the hold identity binding; install it independently
    // of table creation and let postCondition() reject a same-name drift.
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'legal_hold_release_operations'::regclass
            AND conname = 'fk_legal_hold_release_operation_hold'
        ) THEN
          ALTER TABLE "legal_hold_release_operations"
            ADD CONSTRAINT "fk_legal_hold_release_operation_hold"
            FOREIGN KEY ("holdId", "tenantId")
            REFERENCES "legal_holds" ("id", "tenantId")
            ON DELETE RESTRICT;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_legal_hold_release_operation_initiation_request"
      ON "legal_hold_release_operations" ("tenantId", "initiationRequestId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_legal_hold_release_operation_authorization_request"
      ON "legal_hold_release_operations" ("tenantId", "authorizationRequestId")
      WHERE "authorizationRequestId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_legal_hold_release_operation_pending_hold"
      ON "legal_hold_release_operations" ("tenantId", "holdId")
      WHERE "status" = 'PENDING'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "idx_legal_hold_release_operation_tenant_created"
      ON "legal_hold_release_operations" ("tenantId", "initiatedAt" DESC)
    `);

    // The database, not a caller-specific service method, owns the typed state
    // machine. Initial identity/evidence is immutable; a row moves exactly
    // once from PENDING to one terminal state and can never be deleted.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "legal_hold_release_operations_enforce_transition"()
      RETURNS trigger AS $legal_hold_release_transition$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW."status" <> 'PENDING' THEN
            RAISE EXCEPTION USING
              ERRCODE = '55000',
              MESSAGE = 'legal_hold_release_operations must be inserted in PENDING state';
          END IF;
          RETURN NEW;
        END IF;

        IF OLD."status" <> 'PENDING' THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'legal_hold_release_operations terminal states are immutable';
        END IF;

        IF NEW."status" NOT IN ('RELEASED', 'EXPIRED') THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'legal_hold_release_operations only permits PENDING to RELEASED or EXPIRED';
        END IF;

        IF ROW(
          NEW."id",
          NEW."tenantId",
          NEW."holdId",
          NEW."releaseReason",
          NEW."initiationRequestId",
          NEW."initiatedBy",
          NEW."initiatedAt",
          NEW."initiatorMfaVerifiedAt",
          NEW."initiatorTokenId",
          NEW."expiresAt"
        ) IS DISTINCT FROM ROW(
          OLD."id",
          OLD."tenantId",
          OLD."holdId",
          OLD."releaseReason",
          OLD."initiationRequestId",
          OLD."initiatedBy",
          OLD."initiatedAt",
          OLD."initiatorMfaVerifiedAt",
          OLD."initiatorTokenId",
          OLD."expiresAt"
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'legal_hold_release_operations identity and initiation evidence are immutable';
        END IF;

        RETURN NEW;
      END;
      $legal_hold_release_transition$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_legal_hold_release_operations_enforce_transition
      ON "legal_hold_release_operations"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_legal_hold_release_operations_enforce_transition
      BEFORE INSERT OR UPDATE ON "legal_hold_release_operations"
      FOR EACH ROW
      EXECUTE FUNCTION "legal_hold_release_operations_enforce_transition"()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "legal_hold_records_prevent_delete"()
      RETURNS trigger AS $legal_hold_delete_guard$
      BEGIN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = format(
            '%I.%I is retention-guarded; hard DELETE is not permitted',
            TG_TABLE_SCHEMA,
            TG_TABLE_NAME
          );
      END;
      $legal_hold_delete_guard$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_legal_hold_release_operations_prevent_delete
      ON "legal_hold_release_operations"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_legal_hold_release_operations_prevent_delete
      BEFORE DELETE ON "legal_hold_release_operations"
      FOR EACH ROW
      EXECUTE FUNCTION "legal_hold_records_prevent_delete"()
    `);
    await queryRunner.query(`
      REVOKE DELETE ON "legal_hold_release_operations" FROM PUBLIC
    `);

    // NOT VALID keeps pre-protocol history readable while enforcing every new
    // or subsequently updated release row immediately.
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'legal_holds'::regclass
            AND conname = 'chk_legal_hold_no_self_approval'
        ) THEN
          ALTER TABLE "legal_holds"
            ADD CONSTRAINT "chk_legal_hold_no_self_approval"
            CHECK (
              "releasedByApprover" IS NULL
              OR "releasedByApprover" <> "releasedBy"
            ) NOT VALID;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'legal_holds'::regclass
            AND conname = 'chk_legal_hold_release_reason'
        ) THEN
          ALTER TABLE "legal_holds"
            ADD CONSTRAINT "chk_legal_hold_release_reason"
            CHECK (
              "releaseReason" IS NULL
              OR char_length(btrim("releaseReason")) >= 50
            ) NOT VALID;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'legal_holds'::regclass
            AND conname = 'chk_legal_hold_release_state'
        ) THEN
          ALTER TABLE "legal_holds"
            ADD CONSTRAINT "chk_legal_hold_release_state"
            CHECK (
              (
                "isActive" = true
                AND "releasedBy" IS NULL
                AND "releasedByApprover" IS NULL
                AND "releaseReason" IS NULL
                AND "releasedAt" IS NULL
              ) OR (
                "isActive" = false
                AND "releasedBy" IS NOT NULL
                AND "releasedByApprover" IS NOT NULL
                AND "releaseReason" IS NOT NULL
                AND "releasedAt" IS NOT NULL
              )
            ) NOT VALID;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "legal_holds"."expiresAt" IS
        'Review deadline only; isActive remains authoritative until an explicit two-person release.'
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_legal_holds_prevent_delete
      ON "legal_holds"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_legal_holds_prevent_delete
      BEFORE DELETE ON "legal_holds"
      FOR EACH ROW
      EXECUTE FUNCTION "legal_hold_records_prevent_delete"()
    `);
    await queryRunner.query(`
      REVOKE DELETE ON "legal_holds" FROM PUBLIC
    `);

    // Cross-table release parity is checked at transaction commit. Deferred
    // constraint triggers avoid an ordering loophole: the operation and hold
    // may be updated in either order inside one transaction, but neither side
    // can commit alone or with mismatched authorization evidence.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "legal_hold_release_evidence_enforce_parity"()
      RETURNS trigger AS $legal_hold_release_parity$
      BEGIN
        IF TG_TABLE_NAME = 'legal_hold_release_operations' THEN
          IF NEW."status" = 'RELEASED' AND NOT EXISTS (
            SELECT 1
            FROM "legal_holds" hold_state
            WHERE hold_state."id" = NEW."holdId"
              AND hold_state."tenantId" = NEW."tenantId"
              AND hold_state."isActive" = false
              AND hold_state."releasedBy" = NEW."initiatedBy"
              AND hold_state."releasedByApprover" = NEW."authorizedBy"
              AND hold_state."releaseReason" = NEW."releaseReason"
              AND hold_state."releasedAt" = NEW."releasedAt"
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = '55000',
              MESSAGE = 'RELEASED legal hold operation has no exact released hold evidence';
          END IF;
        ELSIF TG_TABLE_NAME = 'legal_holds' THEN
          IF NEW."isActive" = true THEN
            IF EXISTS (
              SELECT 1
              FROM "legal_hold_release_operations" operation_state
              WHERE operation_state."holdId" = NEW."id"
                AND operation_state."tenantId" = NEW."tenantId"
                AND operation_state."status" = 'RELEASED'
            ) THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'A released legal hold cannot be reactivated';
            END IF;
          ELSIF NOT EXISTS (
            SELECT 1
            FROM "legal_hold_release_operations" operation_state
            WHERE operation_state."holdId" = NEW."id"
              AND operation_state."tenantId" = NEW."tenantId"
              AND operation_state."status" = 'RELEASED'
              AND operation_state."initiatedBy" = NEW."releasedBy"
              AND operation_state."authorizedBy" = NEW."releasedByApprover"
              AND operation_state."releaseReason" = NEW."releaseReason"
              AND operation_state."releasedAt" = NEW."releasedAt"
          ) THEN
            RAISE EXCEPTION USING
              ERRCODE = '55000',
              MESSAGE = 'Released legal hold has no exact two-person operation evidence';
          END IF;
        ELSE
          RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = 'Legal hold release parity trigger attached to an unknown table';
        END IF;

        RETURN NEW;
      END;
      $legal_hold_release_parity$ LANGUAGE plpgsql
      SET search_path FROM CURRENT
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_legal_hold_release_operation_evidence_parity
      ON "legal_hold_release_operations"
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_legal_hold_release_operation_evidence_parity
      AFTER INSERT OR UPDATE ON "legal_hold_release_operations"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION "legal_hold_release_evidence_enforce_parity"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_legal_hold_release_evidence_parity
      ON "legal_holds"
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_legal_hold_release_evidence_parity
      AFTER INSERT OR UPDATE ON "legal_holds"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION "legal_hold_release_evidence_enforce_parity"()
    `);
  }

  /**
   * Fail closed when an idempotent tenant fan-out encounters a pre-existing
   * table with the wrong constraint or trigger topology.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const result: unknown = await queryRunner.query(`
      WITH target AS (
        SELECT
          'legal_hold_release_operations'::regclass AS release_table,
          'legal_holds'::regclass AS hold_table
      ),
      release_checks AS (
        SELECT
          COALESCE(
            array_agg(constraint_state.conname::text ORDER BY constraint_state.conname::text),
            ARRAY[]::text[]
          ) = ARRAY[
            'chk_legal_hold_release_operation_distinct_actors',
            'chk_legal_hold_release_operation_reason',
            'chk_legal_hold_release_operation_state',
            'chk_legal_hold_release_operation_status',
            'chk_legal_hold_release_operation_temporal_evidence',
            'chk_legal_hold_release_operation_token_evidence'
          ]::text[]
          AND bool_and(constraint_state.convalidated) AS valid
        FROM pg_constraint constraint_state, target
        WHERE constraint_state.conrelid = target.release_table
          AND constraint_state.contype = 'c'
      ),
      hold_checks AS (
        SELECT COALESCE(
          array_agg(constraint_state.conname::text ORDER BY constraint_state.conname::text)
            FILTER (
              WHERE constraint_state.conname IN (
                'chk_legal_hold_no_self_approval',
                'chk_legal_hold_release_reason',
                'chk_legal_hold_release_state'
              )
            ),
          ARRAY[]::text[]
        ) = ARRAY[
          'chk_legal_hold_no_self_approval',
          'chk_legal_hold_release_reason',
          'chk_legal_hold_release_state'
        ]::text[] AS valid
        FROM pg_constraint constraint_state, target
        WHERE constraint_state.conrelid = target.hold_table
          AND constraint_state.contype = 'c'
      ),
      review_deadline_comment AS (
        SELECT col_description(target.hold_table, attribute.attnum) =
          'Review deadline only; isActive remains authoritative until an explicit two-person release.'
          AS valid
        FROM target
        JOIN pg_attribute attribute
          ON attribute.attrelid = target.hold_table
         AND attribute.attname = 'expiresAt'
         AND NOT attribute.attisdropped
      ),
      hold_fk AS (
        SELECT COUNT(*) = 1
          AND bool_and(
            constraint_state.confrelid = target.hold_table
            AND constraint_state.confdeltype = 'r'
            AND constraint_state.condeferrable = false
            AND ARRAY(
              SELECT attribute.attname::text
              FROM unnest(constraint_state.conkey)
                WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_state.conrelid
               AND attribute.attnum = key_column.attnum
              ORDER BY key_column.position
            ) = ARRAY['holdId', 'tenantId']::text[]
            AND ARRAY(
              SELECT attribute.attname::text
              FROM unnest(constraint_state.confkey)
                WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute attribute
                ON attribute.attrelid = constraint_state.confrelid
               AND attribute.attnum = key_column.attnum
              ORDER BY key_column.position
            ) = ARRAY['id', 'tenantId']::text[]
          ) AS valid
        FROM pg_constraint constraint_state, target
        WHERE constraint_state.conrelid = target.release_table
          AND constraint_state.contype = 'f'
          AND constraint_state.conname = 'fk_legal_hold_release_operation_hold'
      ),
      state_triggers AS (
        SELECT COUNT(*) = 2
          AND bool_and(trigger_state.tgenabled = 'O')
          AND bool_and(
            CASE trigger_state.tgname
              WHEN 'trg_legal_hold_release_operations_enforce_transition'
                THEN trigger_state.tgtype = 23
                  AND function_state.proname = 'legal_hold_release_operations_enforce_transition'
              WHEN 'trg_legal_hold_release_operations_prevent_delete'
                THEN trigger_state.tgtype = 11
                  AND function_state.proname = 'legal_hold_records_prevent_delete'
              ELSE false
            END
          ) AS valid
        FROM pg_trigger trigger_state
        JOIN pg_proc function_state ON function_state.oid = trigger_state.tgfoid
        JOIN target ON trigger_state.tgrelid = target.release_table
        WHERE NOT trigger_state.tgisinternal
          AND trigger_state.tgname IN (
            'trg_legal_hold_release_operations_enforce_transition',
            'trg_legal_hold_release_operations_prevent_delete'
          )
      ),
      hold_retention_trigger AS (
        SELECT COUNT(*) = 1
          AND bool_and(trigger_state.tgenabled = 'O')
          AND bool_and(trigger_state.tgtype = 11)
          AND bool_and(function_state.proname = 'legal_hold_records_prevent_delete')
          AS valid
        FROM pg_trigger trigger_state
        JOIN pg_proc function_state ON function_state.oid = trigger_state.tgfoid
        JOIN target ON trigger_state.tgrelid = target.hold_table
        WHERE NOT trigger_state.tgisinternal
          AND trigger_state.tgname = 'trg_legal_holds_prevent_delete'
      ),
      parity_triggers AS (
        SELECT COUNT(*) = 2
          AND bool_and(trigger_state.tgenabled = 'O')
          AND bool_and(trigger_state.tgdeferrable)
          AND bool_and(trigger_state.tginitdeferred)
          AND bool_and(trigger_state.tgtype = 21)
          AND bool_and(function_state.proname = 'legal_hold_release_evidence_enforce_parity')
          AS valid
        FROM pg_trigger trigger_state
        JOIN pg_proc function_state ON function_state.oid = trigger_state.tgfoid
        JOIN target
          ON trigger_state.tgrelid IN (target.release_table, target.hold_table)
        WHERE NOT trigger_state.tgisinternal
          AND trigger_state.tgname IN (
            'trg_legal_hold_release_operation_evidence_parity',
            'trg_legal_hold_release_evidence_parity'
          )
      )
      SELECT
        release_checks.valid
        AND hold_checks.valid
        AND review_deadline_comment.valid
        AND hold_fk.valid
        AND state_triggers.valid
        AND hold_retention_trigger.valid
        AND parity_triggers.valid AS contract_valid
      FROM
        release_checks,
        hold_checks,
        review_deadline_comment,
        hold_fk,
        state_triggers,
        hold_retention_trigger,
        parity_triggers
    `);

    if (!Array.isArray(result) || result.length !== 1) {
      return false;
    }
    const row: unknown = result[0];
    return (
      typeof row === 'object' &&
      row !== null &&
      'contract_valid' in row &&
      row.contract_valid === true
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'CreateLegalHoldReleaseOperations1802200000000 is forward-only: release authorization evidence cannot be discarded',
    );
  }
}
