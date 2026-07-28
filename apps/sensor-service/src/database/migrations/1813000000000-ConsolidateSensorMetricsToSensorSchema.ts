import { MigrationInterface } from 'typeorm';

/**
 * INERT — this migration's intent was reversed before it was ever released.
 *
 * # What it used to do, and why that is now wrong
 *
 * It consolidated the per-tenant `sensor_metrics` tables INTO the shared
 * `sensor.sensor_metrics` hypertable: a DO-block copied each tenant's rows up
 * and then DROPPED the tenant's table. The premise was that the process-wide
 * ingestion singletons have no per-request search_path, so a single shared
 * hypertable was the only place they could reliably write.
 *
 * That premise was wrong. A metric row carries its own tenantId, so the
 * destination schema is a pure function of the data —
 * SensorMetricWriterService now derives it per row and a singleton writes to the
 * correct tenant schema without needing an ambient one. Telemetry belongs in the
 * tenant's schema (SENSOR-HIGH-085), and migration 1815000000000 delivers the
 * per-tenant hypertable the model always declared.
 *
 * # Why the body is emptied rather than the file deleted
 *
 * Two reasons, both about not breaking things quietly:
 *
 *  1. LEDGER CONSISTENCY. This migration was never released — it exists only on
 *     this branch and no production ledger has run it — but development and CI
 *     databases HAVE run it. Deleting the file would leave those ledgers with a
 *     row naming a migration that no longer exists. Keeping the id and emptying
 *     the body lets every environment converge without hand-editing a ledger.
 *
 *  2. IT WOULD OTHERWISE BE DESTRUCTIVE. Its DO-block is GLOBALLY scoped — it
 *     iterates every `tenant_*` schema regardless of which schema is being
 *     migrated. Tenant provisioning is migration replay against a fresh ledger,
 *     so provisioning ONE new tenant would re-run this loop and drop EVERY other
 *     tenant's `sensor_metrics`. Now that those tables are the real per-tenant
 *     store, leaving the body in place would destroy live telemetry on the next
 *     onboarding.
 *
 * An already-applied ledger row keeps its entry; a database that has not run it
 * records it as applied and does nothing. Both end in the same state.
 */
export class ConsolidateSensorMetricsToSensorSchema1813000000000 implements MigrationInterface {
  name = 'ConsolidateSensorMetricsToSensorSchema1813000000000';

  public async up(): Promise<void> {
    // Intentionally empty — see the docblock. Consolidating telemetry into a
    // shared schema is the behaviour SENSOR-HIGH-085 reverses; re-running the
    // original DO-block would now drop every tenant's live metric table.
  }

  public async down(): Promise<void> {
    // Nothing to undo: this migration no longer changes anything.
  }
}
