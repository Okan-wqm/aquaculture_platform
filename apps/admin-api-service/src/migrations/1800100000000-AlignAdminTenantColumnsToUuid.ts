import { MigrationInterface, QueryRunner } from 'typeorm';

const UUID_RE =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export class AlignAdminTenantColumnsToUuid1800100000000
  implements MigrationInterface
{
  name = 'AlignAdminTenantColumnsToUuid1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.alignTenantColumn(queryRunner, 'tenant_configurations', 'tenantId');
    await this.alignTenantColumn(queryRunner, 'discount_redemptions', 'tenantId');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.convertTenantColumnToText(
      queryRunner,
      'discount_redemptions',
      'tenantId',
    );
    await this.convertTenantColumnToText(
      queryRunner,
      'tenant_configurations',
      'tenantId',
    );
  }

  private async alignTenantColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    const metadata = await queryRunner.query(
      `SELECT udt_name
         FROM information_schema.columns
        WHERE table_schema = 'admin'
          AND table_name = $1
          AND column_name = $2`,
      [table, column],
    );
    const udtName = metadata[0]?.udt_name;
    if (!udtName || udtName === 'uuid') return;

    const invalid = await queryRunner.query(
      `SELECT COUNT(*)::int AS count
         FROM "admin"."${table}"
        WHERE "${column}" IS NOT NULL
          AND "${column}" !~* $1`,
      [UUID_RE],
    );
    if ((invalid[0]?.count ?? 0) > 0) {
      throw new Error(
        `Cannot convert admin.${table}.${column} to uuid: ${invalid[0].count} non-UUID value(s) found`,
      );
    }

    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND udt_name <> 'uuid'
         ) THEN
           ALTER TABLE "admin"."${table}"
             ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid;
         END IF;
       END
       $$`,
    );
  }

  private async convertTenantColumnToText(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'admin'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND udt_name = 'uuid'
         ) THEN
           ALTER TABLE "admin"."${table}"
             ALTER COLUMN "${column}" TYPE character varying USING "${column}"::text;
         END IF;
       END
       $$`,
    );
  }

  private assertSafeIdentifier(value: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Unsafe admin migration identifier: ${value}`);
    }
  }
}
