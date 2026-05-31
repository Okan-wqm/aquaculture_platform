import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function uncommentedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith('#'));
}

describe('deploy SSOT contract', () => {
  it('keeps production/staging compose on registry images only', () => {
    for (const path of ['docker-compose.droplet.yml', 'docker-compose.staging.yml']) {
      const lines = uncommentedLines(read(path));

      expect(lines.filter((line) => /^\s+build:\s*/.test(line))).toEqual([]);
      expect(lines.filter((line) => line.includes('${TAG:-latest}'))).toEqual(
        [],
      );
    }
  });

  it('keeps production deploy scripts away from local builds and volume pruning', () => {
    const script = [
      read('scripts/deploy/droplet-up.sh'),
      read('scripts/deploy/droplet-capacity.sh'),
      read('scripts/deploy-do.sh'),
    ].join('\n');

    expect(script).not.toMatch(/docker\s+build/);
    expect(script).not.toMatch(/docker\s+compose\s+build/);
    expect(script).not.toMatch(/docker-compose\s+build/);
    expect(script).not.toMatch(/up\s+[^#]*--build/);
    expect(script).not.toMatch(/docker\s+volume\s+prune/);
    expect(script).not.toMatch(/docker\s+system\s+prune[^#]*--volumes/);
  });

  it('records deploy capacity and rollback metadata in the release ledger', () => {
    const sql = read(
      'apps/db-migrate/src/sql/platform-bootstrap/007-bootstrap-signal.sql',
    );
    const deploy = read('scripts/deploy/droplet-up.sh');

    for (const column of [
      'deploy_metadata',
      'rollback_manifest_sha256',
      'schema_may_be_forward',
      'rollback_skipped_reason',
    ]) {
      expect(sql).toContain(column);
      expect(deploy).toContain(column);
    }
  });

  it('verifies SHA images and capacity before SSH mutation', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const maintenance = read('.github/workflows/deploy-capacity-maintenance.yml');

    expect(workflow).toContain('verify-images:');
    expect(workflow).toContain('capacity-preflight:');
    expect(workflow).toContain('DEPLOY_IMAGE_DIGESTS_B64');
    expect(workflow).toContain(
      'CAPACITY_GC_MODE=auto bash scripts/deploy/droplet-capacity.sh gate',
    );
    expect(maintenance).toContain('workflow_dispatch:');
    expect(maintenance).toContain('safe-image-gc');
    expect(maintenance).toContain('bash scripts/deploy/droplet-capacity.sh gc');
    expect(maintenance).toContain(
      'CAPACITY_GC_MODE=auto bash scripts/deploy/droplet-capacity.sh gate',
    );
  });
});
