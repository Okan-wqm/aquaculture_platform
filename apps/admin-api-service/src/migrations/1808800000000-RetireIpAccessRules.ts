import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireIpAccessRules — `admin.ip_access_rules` leaves the platform together
 * with the two code stacks that pretended to enforce it (ADR-0010,
 * SEC-HIGH-060).
 *
 * WHY: no request path ever read this table. The admin controller exposed
 * CRUD and a `check` endpoint reachable from a UI button; the gateway carried
 * an IpWhitelistGuard registered in no module, defaulting to open, IPv4-only,
 * backed by an in-memory Map nothing wrote to. A rule saved on the page bound
 * to no tenant, so it would have applied to every tenant had anything
 * evaluated it. The page was a security control that controlled nothing.
 *
 * IP restriction, when it becomes a product requirement, is expressed in
 * `infrastructure/nginx/droplet.conf` (`geo` / `allow` / `deny`) on the real
 * peer address, under the existing config-review gate.
 *
 * SAFETY SHAPE: rows are archived into `admin.retired_config_backups`
 * (jsonb, count-verified) before the table is dropped. The rows are operator
 * intent — which addresses someone wanted allowed or denied — so they are
 * kept as evidence for whoever writes the nginx block; they never carried
 * bearer material.
 */
export class RetireIpAccessRules1808800000000 implements MigrationInterface {
  name = 'RetireIpAccessRules1808800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."retired_config_backups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceTable" character varying(64) NOT NULL,
        "rowData" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_retired_config_backups" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        source_count bigint;
        archived_count bigint;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'ip_access_rules'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM "admin"."retired_config_backups"
            WHERE "sourceTable" = 'ip_access_rules'
          ) THEN
            INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
            SELECT 'ip_access_rules', to_jsonb(t) FROM "admin"."ip_access_rules" t;
          END IF;

          SELECT count(*) INTO source_count FROM "admin"."ip_access_rules";
          SELECT count(*) INTO archived_count
            FROM "admin"."retired_config_backups" WHERE "sourceTable" = 'ip_access_rules';
          IF archived_count < source_count THEN
            RAISE EXCEPTION
              'retired_config_backups holds % rows for ip_access_rules but the source still has % — refusing to drop before the archive is complete',
              archived_count, source_count;
          END IF;

          -- DESTRUCTIVE: rows archived above into admin.retired_config_backups (jsonb, count-verified); rollback = restore rows from the archive
          DROP TABLE IF EXISTS "admin"."ip_access_rules";
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. Recreating the table would reinstate a
    // security-control record with no enforcer (ADR-0010). The archived rows
    // live in admin.retired_config_backups under sourceTable = 'ip_access_rules'.
  }
}
