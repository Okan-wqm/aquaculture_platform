import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MovePublicTablesToNotification1786000200000
 * ============================================================================
 *
 * Moves two notification-owned tables from `public` to the `notification`
 * schema:
 *
 *   - public.device_tokens     → notification.device_tokens
 *   - public.notification_logs → notification.notification_logs
 *
 * Phase 6/7 of docs/plans/2026-04-14 public-schema teardown. Both tables
 * are declared in MODULE_SCHEMAS[notification] (schema-manager.service.ts
 * added in P1) but previously lived in public because neither
 * @Entity decorator specified `schema:`. This migration makes the
 * physical location match the declared ownership.
 *
 * # notification_logs — live production data
 *
 * notification_logs carries delivery history (emails sent, push
 * receipts, SMS attempts). The SET SCHEMA operation takes ACCESS
 * EXCLUSIVE for sub-millisecond regardless of row count, so this is
 * safe under normal write load. The retention service (cron, runs every
 * 24h) holds no long transactions on this table so there's no deadlock
 * risk.
 *
 * # device_tokens — APNs/FCM registry
 *
 * device_tokens holds active push-notification credentials. Lookups are
 * by (tenantId, userId, platform) composite index which travels with
 * the table through SET SCHEMA unchanged. Zero query-path impact.
 *
 * # See farm-service migration 1786000000000 for full architectural
 *   rationale (SET SCHEMA semantics, RLS policy preservation).
 */
export class MovePublicTablesToNotification1786000200000
  implements MigrationInterface
{
  name = 'MovePublicTablesToNotification1786000200000';

  private readonly tables = ['device_tokens', 'notification_logs'];

  public async up(qr: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'notification' AND tablename = '${table}'
          ) THEN
            ALTER TABLE public.${table} SET SCHEMA notification;
            ALTER TABLE notification.${table} OWNER TO notification_service;
            ALTER TABLE notification.${table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE notification.${table} FORCE ROW LEVEL SECURITY;
          END IF;
        END $$;
      `);
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    for (const table of [...this.tables].reverse()) {
      await qr.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'notification' AND tablename = '${table}'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'
          ) THEN
            ALTER TABLE notification.${table} SET SCHEMA public;
            ALTER TABLE public.${table} OWNER TO shared_public_owner;
          END IF;
        END $$;
      `);
    }
  }
}
