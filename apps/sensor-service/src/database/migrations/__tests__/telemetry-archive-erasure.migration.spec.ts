import {
  TELEMETRY_ARCHIVE_ERASURE_UP_STATEMENTS,
  TelemetryArchiveErasure1816000000003,
} from '../1816000000003-TelemetryArchiveErasure';

describe('TelemetryArchiveErasure1816000000003', () => {
  const ddl = TELEMETRY_ARCHIVE_ERASURE_UP_STATEMENTS.join('\n');

  it('keeps normal ledger mutation blocked and exposes one privileged erasure function', () => {
    expect(ddl).toContain('telemetry_archive_events_immutable');
    expect(ddl).toContain('erase_telemetry_archive_tenant_links');
    expect(ddl).toContain('SECURITY DEFINER');
    expect(ddl).toContain('REVOKE ALL ON FUNCTION');
    expect(ddl).toContain('GRANT USAGE ON SCHEMA sensor TO telemetry_archive_erasure');
  });

  it('checks the authoritative legal-hold registry and returns non-sensitive erasure evidence', () => {
    expect(ddl).toContain('compliance.legal_holds');
    expect(ddl).toContain('"scope" = \'tenant\'');
    expect(ddl).toContain('"resourceId" IS NULL');
    expect(ddl).toContain('"releasedAt" IS NULL');
    expect(ddl).not.toContain('messaging.legal_holds');
    expect(ddl).not.toContain('p_legal_hold_checked_at');
    expect(ddl).toContain('deleted_event_count');
    expect(ddl).toContain('evidence_sha256');
  });

  it('provisions a no-CREATE restore capability with allowlisted create and TTL cleanup functions', () => {
    expect(ddl).toContain('telemetry_archive_restore NOLOGIN');
    expect(ddl).toContain('create_telemetry_restore_scratch');
    expect(ddl).toContain('drop_expired_telemetry_restore_scratch');
    expect(ddl).toContain("nspname ~ '^restore_[0-9a-f]{32}$'");
    expect(ddl).toContain('GRANT SELECT ON %I.restore_metadata');
    expect(ddl).toContain('GRANT SELECT, INSERT ON %I.sensor_metrics');
    expect(ddl).not.toContain('GRANT SELECT, INSERT ON ALL TABLES');
    expect(ddl).toContain('v_metadata_count <> 1');
    expect(ddl).not.toContain('GRANT CREATE ON DATABASE');
  });

  it('persists the complete Parquet manifest through a constrained v2 append path', () => {
    expect(ddl).toContain('append_telemetry_archive_event_v2');
    expect(ddl).toContain('bucket_name');
    expect(ddl).toContain('object_version_id');
    expect(ddl).toContain('archive_format');
    expect(ddl).toContain('min_time');
    expect(ddl).toContain('max_time');
    expect(ddl).toContain("p_archive_format IS DISTINCT FROM 'PARQUET'");
    expect(ddl).toContain('append_telemetry_archive_event_state_machine');
    expect(ddl).toContain('VERIFIED manifest must exactly match EXPORTED manifest');
    expect(ddl).toContain("'^aqua-telemetry-[0-9a-f]{32}$'");
    expect(ddl).not.toContain('GRANT EXECUTE ON FUNCTION sensor.append_telemetry_archive_event(');
    expect(ddl).not.toContain('app.telemetry_archive_manifest_operation_id');
  });

  it('durably fences erased tenants and records revocable presign evidence', () => {
    expect(ddl).toContain('telemetry_archive_cancellations');
    expect(ddl).toContain('assert_telemetry_archive_tenant_active');
    expect(ddl).toContain('cancel_telemetry_archive_tenant');
    expect(ddl).toContain('telemetry_archive_presigns');
    expect(ddl).toContain('record_telemetry_archive_presign');
    expect(ddl).toContain('revoke_telemetry_archive_presigns');
    expect(ddl).toContain('sensor.tenant_erasure_target_proofs WHERE "tenantId" = p_tenant_id');
    expect(ddl).not.toContain('sensor.tenant_erasure_target_proofs WHERE tenant_id');
  });

  it('is forward-only so erasure evidence cannot be resurrected accidentally', () => {
    const migration = new TelemetryArchiveErasure1816000000003();
    expect(migration.down({} as never)).rejects.toThrow(/forward-only/i);
  });
});
