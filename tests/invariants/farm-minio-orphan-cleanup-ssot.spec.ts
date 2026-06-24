import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT (FARM-CRITICAL-001): farm MinIO orphan cleanup is tenant-scoped and fail-closed', () => {
  const cronSource = read('apps/farm-service/src/scheduler/cron-jobs.service.ts');
  const farmCleanupSource = read(
    'apps/farm-service/src/common/file-cleanup/farm-orphan-cleanup.service.ts',
  );
  const storageCleanupSource = read('libs/storage/src/orphan-cleanup.service.ts');
  const minioClientSource = read('libs/storage/src/minio-client.service.ts');

  it('runs one cleanup per tenant using canonical tenant context and tenant object prefix', () => {
    expect(cronSource).toMatch(
      /import\s+\{\s*withTenantContext\s*\}\s+from\s+['"]@aquaculture\/backend-common\/context['"]/,
    );
    expect(cronSource).toMatch(/listTenantSchemas\(this\.dataSource\)/);
    expect(cronSource).toMatch(/await\s+withTenantContext\(tenantId,\s*async\s*\(\)\s*=>/);
    expect(cronSource).toMatch(/orphanCleanup!\.run\(\{\s*prefix:\s*`\$\{tenantId\}\/`\s*\}\)/);
    expect(cronSource).not.toMatch(/orphanCleanup!\.run\(\s*\)/);
    expect(cronSource).not.toMatch(/allowEmptyLiveSet\s*:\s*true/);
  });

  it('keeps farm-service live-path collection authoritative and never exposes allowEmptyLiveSet', () => {
    expect(farmCleanupSource).toMatch(/class FarmOrphanCleanupService/);
    expect(farmCleanupSource).toMatch(/FileReferenceProvider/);
    expect(farmCleanupSource).toMatch(/collectLivePaths\(\)/);
    expect(farmCleanupSource).toMatch(/this\.cleanup\.cleanup\(\{\s*livePaths:\s*live,/);
    expect(farmCleanupSource).toMatch(/prefix:\s*options\?\.prefix/);
    expect(farmCleanupSource).not.toMatch(/allowEmptyLiveSet/);
  });

  it('keeps the storage primitive fail-closed when a non-empty prefix scan has an empty live set', () => {
    expect(storageCleanupSource).toMatch(/allowEmptyLiveSet\?:\s*boolean/);
    expect(storageCleanupSource).toMatch(/objects\.length\s*>\s*0/);
    expect(storageCleanupSource).toMatch(/request\.livePaths\.size\s*===\s*0/);
    expect(storageCleanupSource).toMatch(/!request\.allowEmptyLiveSet/);
    expect(storageCleanupSource).toMatch(/refused:\s*true/);
  });

  it('keeps generated object paths tenant-prefixed', () => {
    expect(minioClientSource).toMatch(/generateFilePath\(/);
    expect(minioClientSource).toMatch(/return\s+`\$\{tenantId\}\/\$\{entityType\}\/\$\{entityId\}\/\$\{safeFilename\}`/);
  });
});
