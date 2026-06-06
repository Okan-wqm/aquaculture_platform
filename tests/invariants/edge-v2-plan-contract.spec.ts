import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EDGE_ADR_022 = 'docs/adr/022-edge-schema-placement.md';
const OLD_EDGE_ADR_025 = 'docs/adr/025-edge-schema-sensor-per-tenant-ownership.md';
const RUST_ADR_025 = 'docs/adr/025-rust-sidecar-architecture.md';
const EDGE_ADR_034 = 'docs/adr/034-edge-schema-sensor-per-tenant-ownership.md';
const EDGE_PLAN = 'docs/plans/2026-05-12-sens-api-gateway-edge-platform-v2-revision.md';
const EDGE_EVIDENCE = 'docs/evidence/sens-api-gateway-edge-v2.0.0-rc4.md';
const EDGE_RELEASE = 'docs/releases/sens-api-gateway-edge-v2.0.0-rc4.md';

const ACTIVE_EDGE_DOCS = [EDGE_PLAN, EDGE_EVIDENCE, EDGE_RELEASE] as const;

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

describe('edge v2.0 planning source of truth', () => {
  const edgeAdr022 = read(EDGE_ADR_022);
  const rustAdr025 = read(RUST_ADR_025);
  const edgeAdr034 = read(EDGE_ADR_034);
  const edgePlan = read(EDGE_PLAN);

  it('keeps ADR-025 for Rust and ADR-034 for edge schema ownership', () => {
    expect(exists(OLD_EDGE_ADR_025)).toBe(false);
    expect(rustAdr025).toContain('# ADR-025:');
    expect(edgeAdr034).toContain('# ADR-034:');
    expect(edgeAdr034).toContain('**Status:** Accepted');
    expect(edgeAdr022).toContain('**SUPERSEDED by ADR-034');
    expect(edgeAdr022).toContain(EDGE_ADR_034);
  });

  it('makes ADR-034 the active edge planning authority', () => {
    for (const relPath of ACTIVE_EDGE_DOCS) {
      const doc = read(relPath);
      expect(doc).toContain('ADR-034');
      expect(doc).not.toContain('ADR-025 is authoritative for Edge schema ownership');
      expect(doc).not.toContain('ADR-022 is the schema source of truth');
      expect(doc).not.toContain('Phase 2 cannot start unless `docs/adr/022-edge-schema-placement.md`');
    }
  });

  it('rejects admin-api-owned dedicated edge schema assumptions in the active plan', () => {
    for (const forbidden of [
      'apps/admin-api-service/src/migrations/edge',
      'apps/admin-api-service/src/edge/entities',
      'Nine ordered ADR-022 migrations',
      '`edge.devices`',
      '`edge.policies`',
      '`edge.licenses`',
      '`edge.provisioning_records`',
      '`edge.firmware_releases`',
      '`edge.audit_archive_v1`',
    ]) {
      expect(edgePlan).not.toContain(forbidden);
    }

    expect(edgePlan).toContain('`apps/sensor-service/src/database/migrations`');
    expect(edgePlan).toContain('`apps/sensor-service/src/edge-device/entities/v2`');
    expect(edgePlan).toContain('db-migrate tenant schema provisioner');
    expect(edgePlan).toContain('Open Host Service consumer only; no direct SQL writes or reads');
  });

  it('keeps sensor-ingestion registered but inactive for v2.0 production planning', () => {
    expect(edgePlan).toContain('`sensor-service` is production-active');
    expect(edgePlan).toContain('`sensor-ingestion` is registered/inactive');
    expect(edgePlan).toContain('Catalog registration is not the same as production-active status');
  });
});
