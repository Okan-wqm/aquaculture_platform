import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/**
 * RC-1 canonical paginated-response SSoT (phase A). Locks the interceptor seam
 * and the migrated producers so the "list renders empty / crashes on .data"
 * class cannot regrow in the services already converted. Full canonicalisation
 * of the remaining {data,total} producers + removal of the legacy interceptor
 * branch is tracked as RC-1b (ADMIN-CRITICAL-007).
 */
describe('admin-api canonical pagination envelope (RC-1)', () => {
  it('the ResponseInterceptor recognises the canonical shape and passes binary through', () => {
    const src = read('apps/admin-api-service/src/shared/response.interceptor.ts');
    expect(src).toContain('isStandardPaginatedResult');
    expect(src).toContain('StreamableFile');
    expect(src).toContain('Buffer.isBuffer');
  });

  it('the canonical guard + factory live in the pagination SSoT', () => {
    const src = read('libs/backend-common/src/pagination/pagination.dto.ts');
    expect(src).toContain('export function isStandardPaginatedResult');
    expect(src).toContain('export function createStandardPaginatedResult');
    const barrel = read('libs/backend-common/src/pagination/index.ts');
    expect(barrel).toContain('isStandardPaginatedResult');
  });

  it('migrated list producers route through createStandardPaginatedResult (no bare {items,total})', () => {
    const migrated = [
      'apps/admin-api-service/src/system-management/services/global-settings.service.ts',
      'apps/admin-api-service/src/system-management/services/error-tracking.service.ts',
      'apps/admin-api-service/src/system-management/services/job-queue.service.ts',
      'apps/admin-api-service/src/billing/services/custom-plan.service.ts',
    ];
    for (const file of migrated) {
      const src = read(file);
      expect(src).toContain('createStandardPaginatedResult');
      // No bare paginated literal survives in a migrated producer.
      expect(src).not.toMatch(/return \{ items, total \}/);
    }
  });
});
