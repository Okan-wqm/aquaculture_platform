import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve(__dirname, '../../infrastructure/scripts/postgres-dr-recovery.sh');

describe('PostgreSQL cold recovery point', () => {
  it('copies the complete stopped cluster including legacy TLS bytes without modifying the source', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cold-copy-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'point');
      mkdirSync(source);
      mkdirSync(destination);
      writeFileSync(join(source, 'PG_VERSION'), '16\n');
      writeFileSync(join(source, 'server.key'), 'fixture-private-key\n', { mode: 0o600 });
      const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dr_copy_cluster "$2" "$3"', '--', helper, source, destination], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(readFileSync(join(source, 'server.key'), 'utf8')).toBe('fixture-private-key\n');
      expect(readFileSync(join(destination, 'server.key'), 'utf8')).toBe('fixture-private-key\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a cluster with an uncaptured external tablespace instead of claiming a complete backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-cold-copy-'));
    try {
      mkdirSync(join(root, 'source'));
      mkdirSync(join(root, 'point'));
      writeFileSync(join(root, 'source', 'PG_VERSION'), '16\n');
      symlinkSync('/uncaptured/tablespace', join(root, 'source', 'tablespace'));
      const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dr_copy_cluster "$2" "$3"', '--', helper, join(root, 'source'), join(root, 'point')], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires a verified recovery-point binding before the durable mutation phase', () => {
    const script = readFileSync(resolve(__dirname, '../../infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh'), 'utf8');
    const preparation = script.indexOf('prepare_postgres_recovery_point');
    const mutation = script.indexOf('"${STATE_PATH}" PREPARED FORWARD_STARTED');
    expect(preparation).toBeGreaterThan(0);
    expect(mutation).toBeGreaterThan(preparation);
    expect(script).toContain('verify_postgres_recovery_point');
    expect(script).toContain('RECOVERY_REQUIRED');
  });
});
