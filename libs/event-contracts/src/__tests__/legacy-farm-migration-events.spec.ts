/**
 * Contract tests for Phase 4.3 legacy farm-migration events.
 *
 * These are audit events emitted by the `farm-service migrate-
 * legacy-farm` CLI (Phase 4.3.1) and by the later table-conversion
 * migration (Phase 4.3.3 / 4.3.5). They never ride through NATS-
 * ingress validation the way sensor readings do — consumers are
 * observability + compliance-export + read-model rebuilders —
 * so no JSONSchemaType gate is required.
 *
 * What these tests DO pin:
 *   1. The `eventType` discriminator string is the exact literal
 *      the CLI writes. Typos here would silently drop the event
 *      from any consumer that filters by `eventType`.
 *   2. The events type-check as a member of `FarmEvent` union.
 *      This closes the "forgot to update the union" regression
 *      the existing farm-events test pattern guards against.
 *   3. JSON round-trip preserves every field (no Date-to-string
 *      loss — the consumer rehydrates Date from ISO-8601 string,
 *      which `JSON.stringify` + `JSON.parse` handle correctly).
 */
import { createBaseEvent } from '../base-event';
import type {
  FarmEvent,
  LegacyFarmDataMigratedEvent,
  LegacyFarmTableConvertedEvent,
} from '../farm-events';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('LegacyFarmDataMigratedEvent', () => {
  function makeEvent(): LegacyFarmDataMigratedEvent {
    return {
      ...createBaseEvent<LegacyFarmDataMigratedEvent>(
        'LegacyFarmDataMigrated',
        TENANT,
        { aggregateId: TENANT, aggregateType: 'Tenant' },
      ),
      tenantSchemaName: 'tenant_9f83a2b1c4d5e6f7',
      farmsMigrated: 3,
      farmsSkipped: 0,
      pondsMigrated: 12,
      pondsSkipped: 1,
      syntheticDepartmentsCreated: 3,
      operatorId: 'ops-user-42',
      migrationStartedAt: '2026-04-24T08:00:00.000Z',
      migrationCompletedAt: '2026-04-24T08:00:03.000Z',
    };
  }

  it('carries the exact eventType discriminator literal', () => {
    const event = makeEvent();
    expect(event.eventType).toBe('LegacyFarmDataMigrated');
  });

  it('is assignable to the FarmEvent union (union drift guard)', () => {
    // Compile-time check: if LegacyFarmDataMigratedEvent is not in
    // the FarmEvent union, this line fails to type-check.
    const event: FarmEvent = makeEvent();
    expect(event.eventType).toBeDefined();
  });

  it('preserves every field through a JSON round-trip', () => {
    const original = makeEvent();
    const roundTripped = JSON.parse(
      JSON.stringify(original),
    ) as unknown as LegacyFarmDataMigratedEvent;

    expect(roundTripped.eventType).toBe(original.eventType);
    expect(roundTripped.tenantSchemaName).toBe(original.tenantSchemaName);
    expect(roundTripped.farmsMigrated).toBe(3);
    expect(roundTripped.farmsSkipped).toBe(0);
    expect(roundTripped.pondsMigrated).toBe(12);
    expect(roundTripped.pondsSkipped).toBe(1);
    expect(roundTripped.syntheticDepartmentsCreated).toBe(3);
    expect(roundTripped.operatorId).toBe('ops-user-42');
    // Dates serialize as ISO-8601 strings through JSON; the consumer
    // is responsible for `new Date(...)` rehydration. Assert the
    // serialised form is the expected ISO string.
    expect(roundTripped.migrationStartedAt).toBe('2026-04-24T08:00:00.000Z');
    expect(roundTripped.migrationCompletedAt).toBe('2026-04-24T08:00:03.000Z');
  });

  it('accepts zero counts on an idempotent re-run', () => {
    // Re-run where every row was already migrated: all skipped.
    const event: LegacyFarmDataMigratedEvent = {
      ...makeEvent(),
      farmsMigrated: 0,
      farmsSkipped: 3,
      pondsMigrated: 0,
      pondsSkipped: 12,
      syntheticDepartmentsCreated: 0,
    };
    expect(event.farmsMigrated).toBe(0);
    expect(event.farmsSkipped).toBe(3);
  });
});

describe('LegacyFarmTableConvertedEvent', () => {
  function makeTableToViewEvent(table: 'farms' | 'ponds'): LegacyFarmTableConvertedEvent {
    return {
      ...createBaseEvent<LegacyFarmTableConvertedEvent>(
        'LegacyFarmTableConverted',
        TENANT,
        { aggregateId: TENANT, aggregateType: 'Tenant' },
      ),
      tenantSchemaName: 'tenant_9f83a2b1c4d5e6f7',
      table,
      phase: 'table-to-view',
      rowCount: 42,
      convertedAt: '2026-05-01T12:00:00.000Z',
    };
  }

  it('carries the exact eventType discriminator literal', () => {
    const event = makeTableToViewEvent('farms');
    expect(event.eventType).toBe('LegacyFarmTableConverted');
  });

  it('is assignable to the FarmEvent union', () => {
    const event: FarmEvent = makeTableToViewEvent('farms');
    expect(event.eventType).toBeDefined();
  });

  it('accepts both `farms` and `ponds` on the table discriminator', () => {
    expect(makeTableToViewEvent('farms').table).toBe('farms');
    expect(makeTableToViewEvent('ponds').table).toBe('ponds');
  });

  it('accepts both `table-to-view` and `view-dropped` on the phase discriminator', () => {
    const tableToView = makeTableToViewEvent('farms');
    expect(tableToView.phase).toBe('table-to-view');

    const viewDropped: LegacyFarmTableConvertedEvent = {
      ...tableToView,
      phase: 'view-dropped',
      rowCount: 0,
    };
    expect(viewDropped.phase).toBe('view-dropped');
    expect(viewDropped.rowCount).toBe(0);
  });

  it('preserves every field through a JSON round-trip', () => {
    const original = makeTableToViewEvent('ponds');
    const roundTripped = JSON.parse(
      JSON.stringify(original),
    ) as unknown as LegacyFarmTableConvertedEvent;

    expect(roundTripped.eventType).toBe(original.eventType);
    expect(roundTripped.tenantSchemaName).toBe(original.tenantSchemaName);
    expect(roundTripped.table).toBe('ponds');
    expect(roundTripped.phase).toBe('table-to-view');
    expect(roundTripped.rowCount).toBe(42);
    expect(roundTripped.convertedAt).toBe('2026-05-01T12:00:00.000Z');
  });
});
