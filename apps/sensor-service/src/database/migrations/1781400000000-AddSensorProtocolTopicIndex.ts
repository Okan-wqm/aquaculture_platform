import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * AddSensorProtocolTopicIndex1781400000000
 * ============================================================================
 *
 * Installs a B-tree **expression** index on
 * `sensors.protocol_configuration->>'topic'` across the `sensor` source
 * schema and every provisioned `tenant_<uuid>` schema.
 *
 * # Why a B-tree expression index, not a GIN index?
 *
 * The audit report (H-3, Phase 1) originally suggested "add GIN indexes
 * to hot JSONB columns" as a generic rule. After tracing the actual
 * hot-path query in `mqtt-listener.service.ts`, a GIN index is the
 * WRONG shape for this workload:
 *
 * ```ts
 * await queryRunner.manager
 *   .getRepository(Sensor)
 *   .createQueryBuilder('sensor')
 *   .where(`sensor."protocol_configuration"->>'topic' = :topic`, { topic })
 *   .getOne();
 * ```
 *
 * The predicate is **scalar equality on an extracted text value**, not a
 * containment/key-existence check. For that pattern, a B-tree index on
 * the extracted expression is strictly better than GIN:
 *
 * | Query pattern                          | GIN    | B-tree expr       |
 * | -------------------------------------- | ------ | ----------------- |
 * | `jsonb_col @> '{"k":"v"}'`             | Yes    | No                |
 * | `jsonb_col ? 'key'`                    | Yes    | No                |
 * | `(jsonb_col->>'k') = 'v'`              | **No** | **Yes** (perfect) |
 * | `(jsonb_col->>'k') LIKE 'prefix%'`     | No     | Yes               |
 * | `(jsonb_col->>'k') BETWEEN x AND y`    | No     | Yes               |
 *
 * GIN's internal posting lists index _paths inside the document_, not
 * _projected scalars_. Using GIN for `->>'k' = 'v'` forces the planner
 * to either fall back to a seq scan (most common) or re-check every
 * candidate row after the GIN probe — neither is an acceleration.
 *
 * A B-tree on `(protocol_configuration->>'topic')` turns the MQTT hot
 * path from O(n) per tenant schema to O(log n), which is the kind of
 * asymptotic win worth paying for.
 *
 * # Why a partial index?
 *
 * Most sensors have `protocol_configuration = NULL` (provisioned but
 * not yet configured). Including NULL rows in the index:
 *
 * 1. Bloats the B-tree with empty entries, slowing scans.
 * 2. Adds write overhead on every INSERT/UPDATE of NULL-configured
 *    sensors that will never be looked up by topic.
 *
 * `WHERE protocol_configuration IS NOT NULL` keeps only the useful
 * subset. The planner uses this partial index only when the query's
 * WHERE clause implies the predicate — which it does, because
 * `protocol_configuration->>'topic' = 'foo'` fails NULL tests.
 *
 * # Why iterate schemas?
 *
 * sensor-service is schema-per-tenant: every tenant has its own
 * `tenant_<uuid>.sensors` table, provisioned via
 * `CREATE TABLE LIKE sensor.sensors INCLUDING ALL`. `INCLUDING ALL`
 * copies indexes **that existed at provision time** — a new index on
 * the source schema is NOT automatically propagated to existing
 * tenants.
 *
 * Same challenge as `ConvertMessagingOutboxToIdentity1781200000000`.
 * Same solution: iterate every schema that contains a `sensors` base
 * table (source + tenants), install the index in each. Sub-millisecond
 * per schema; cumulative time scales linearly with tenant count.
 *
 * # Wildcard fallback is NOT indexed
 *
 * The second half of `findSensorByTopicLegacy` runs:
 *
 * ```sql
 * WHERE protocol_configuration->>'topic' LIKE '%#%'
 *    OR protocol_configuration->>'topic' LIKE '%+%'
 * ```
 *
 * A leading `%` kills B-tree prefix matching, so this query stays a
 * full scan no matter what we index. That's acceptable because:
 *
 * 1. It only runs as a fallback when the exact-match query returns no
 *    row (i.e. the topic has no exact configured match, suggesting it
 *    might be a wildcard-style subscription).
 * 2. The exact-match path — which now gets the index — handles the
 *    overwhelming majority of MQTT messages.
 *
 * A trigram index (`pg_trgm`) could accelerate the LIKE scan but adds
 * a dependency without clear evidence of need; deferred to a future
 * phase if MQTT throughput profiling shows the wildcard path as hot.
 *
 * # Idempotency
 *
 * `CREATE INDEX IF NOT EXISTS` + schema discovery from
 * `information_schema` makes the migration safe to re-run on any
 * environment, including partial failures.
 */
export class AddSensorProtocolTopicIndex1781400000000
  implements MigrationInterface
{
  name = 'AddSensorProtocolTopicIndex1781400000000';
  private readonly logger = new MigrationLogger(this.name);

  private readonly indexName = 'idx_sensors_protocol_topic';

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Installing B-tree expression index on sensors.protocol_configuration->>topic',
    );

    const schemas = await this.discoverSchemas(queryRunner);

    if (schemas.length === 0) {
      this.logger.warn(
        'No schemas with sensors table found — nothing to index. ' +
          'This is expected on environments before TenantSchemaSyncService ' +
          'has provisioned any tenant.',
      );
      return;
    }

    this.logger.log(
      `Found ${schemas.length} schemas with sensors: ${schemas.join(', ')}`,
    );

    for (const schema of schemas) {
      // Defensive identifier validation — even though the schema list
      // comes from information_schema (trusted), we interpolate it into
      // the SQL directly so the regex check closes the only remaining
      // injection surface.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        this.logger.warn(`Skipping invalid schema name: "${schema}"`);
        continue;
      }

      // CREATE INDEX IF NOT EXISTS — the same index installed twice is
      // a no-op. Partial index scoped to rows with non-NULL
      // protocol_configuration to keep the B-tree small.
      //
      // The expression `("protocol_configuration"->>'topic')` must be
      // parenthesized for CREATE INDEX — unlike SELECT where bare
      // `col->>'k'` is legal, CREATE INDEX on expressions requires the
      // outer parens.
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "${this.indexName}"
        ON "${schema}"."sensors" (("protocol_configuration"->>'topic'))
        WHERE "protocol_configuration" IS NOT NULL
      `);

      this.logger.log(
        `[${schema}] installed ${this.indexName} on (protocol_configuration->>'topic')`,
      );
    }

    this.logger.log(
      `Sensor topic index installed in ${schemas.length} schemas`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Dropping sensors.protocol_configuration->topic index across all schemas. ' +
        'MQTT topic lookup will fall back to seq scan per tenant schema — ' +
        'performance will degrade at high ingestion rates.',
    );

    const schemas = await this.discoverSchemas(queryRunner);

    for (const schema of schemas) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) continue;

      await queryRunner.query(
        `DROP INDEX IF EXISTS "${schema}"."${this.indexName}"`,
      );
      this.logger.warn(`[${schema}] dropped ${this.indexName}`);
    }
  }

  /**
   * Find every schema that contains a `sensors` base table. Used by
   * both up() and down() so the set of schemas touched is symmetric.
   */
  private async discoverSchemas(queryRunner: QueryRunner): Promise<string[]> {
    const rows: Array<{ table_schema: string }> = await queryRunner.query(`
      SELECT table_schema
      FROM information_schema.tables
      WHERE table_name = 'sensors'
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema
    `);
    return rows.map((r) => r.table_schema);
  }
}
