import { MigrationInterface, QueryRunner } from 'typeorm';

const UUID_RE =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export class AlignAlertTenantColumnsToUuid1800100000000
  implements MigrationInterface
{
  name = 'AlignAlertTenantColumnsToUuid1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    await this.alignTenantColumn(queryRunner, schema, 'alert_rules', 'tenant_id');
    await this.alignTenantColumn(queryRunner, schema, 'escalation_policies', 'tenant_id');
    await this.alignTenantColumn(queryRunner, schema, 'alert_history', 'tenant_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    await this.convertTenantColumnToText(
      queryRunner,
      schema,
      'alert_history',
      'tenant_id',
    );
    await this.convertTenantColumnToText(
      queryRunner,
      schema,
      'escalation_policies',
      'tenant_id',
    );
    await this.convertTenantColumnToText(
      queryRunner,
      schema,
      'alert_rules',
      'tenant_id',
    );
  }

  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const rows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const schema = rows[0]?.current_schema;
    if (!schema || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw new Error(`Unsafe current_schema() for alert tenant alignment: ${schema}`);
    }
    return schema;
  }

  private async alignTenantColumn(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(schema);
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    const metadata = await queryRunner.query(
      `SELECT udt_name
        FROM information_schema.columns
       WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3`,
      [schema, table, column],
    );
    const udtName = metadata[0]?.udt_name;
    if (!udtName || udtName === 'uuid') return;

    const invalid = await queryRunner.query(
      `SELECT COUNT(*)::int AS count
         FROM "${schema}"."${table}"
        WHERE "${column}" IS NOT NULL
          AND "${column}" !~* $1`,
      [UUID_RE],
    );
    if ((invalid[0]?.count ?? 0) > 0) {
      throw new Error(
        `Cannot convert ${schema}.${table}.${column} to uuid: ${invalid[0].count} non-UUID value(s) found`,
      );
    }

    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = '${schema}'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND udt_name <> 'uuid'
         ) THEN
           ALTER TABLE "${schema}"."${table}"
             ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid;
         END IF;
       END
       $$`,
    );
  }

  private async convertTenantColumnToText(
    queryRunner: QueryRunner,
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(schema);
    this.assertSafeIdentifier(table);
    this.assertSafeIdentifier(column);

    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = '${schema}'
              AND table_name = '${table}'
              AND column_name = '${column}'
              AND udt_name = 'uuid'
         ) THEN
           ALTER TABLE "${schema}"."${table}"
             ALTER COLUMN "${column}" TYPE character varying USING "${column}"::text;
         END IF;
       END
       $$`,
    );
  }

  private assertSafeIdentifier(value: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Unsafe alert migration identifier: ${value}`);
    }
  }
}
