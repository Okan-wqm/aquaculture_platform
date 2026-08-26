import { TELEMETRY_ARCHIVE_UP_STATEMENTS } from '../1816000000002-TelemetryArchiveLifecycle';

describe('TelemetryArchiveLifecycle1816000000002', () => {
  const ddl = TELEMETRY_ARCHIVE_UP_STATEMENTS.join('\n');

  it('creates the cross-tenant append-only lifecycle ledger', () => {
    expect(ddl).toContain('CREATE TABLE "sensor"."telemetry_archive_events"');
    expect(ddl).toContain('telemetry_archive_events_immutable');
    expect(ddl).toContain('BEFORE UPDATE OR DELETE');
    expect(ddl).toContain('REVOKE INSERT, UPDATE, DELETE');
  });

  it('serializes overlapping tenant ranges and validates the state machine in PostgreSQL', () => {
    expect(ddl).toContain('pg_advisory_xact_lock');
    expect(ddl).toContain('append_telemetry_archive_event');
    expect(ddl).toContain("v_previous_state = 'EXPORT_STARTED' AND p_state = 'EXPORTED'");
    expect(ddl).toContain("v_previous_state = 'EXPORTED' AND p_state = 'VERIFIED'");
    expect(ddl).toContain("v_previous_state = 'VERIFIED' AND p_state = 'DROPPED'");
  });

  it('keeps raw drop disabled unless both technical and legal gates are transaction-local', () => {
    expect(ddl).toContain("current_setting('app.telemetry_retention_enabled', true)");
    expect(ddl).toContain("current_setting('app.legal_001_approved', true)");
  });

  it('requires retries to use a new operation that supersedes a terminal failure', () => {
    expect(ddl).toContain('superseded operation must be FAILED');
    expect(ddl).toContain('cannot append to terminal FAILED operation');
  });
});
