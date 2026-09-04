import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('runtime module wiring', () => {
  it('exports the sensor metric writer only from its owning Nest module', () => {
    const ingestionModule = read('apps/sensor-service/src/ingestion/ingestion.module.ts');
    const exportsBlock = /exports:\s*\[([\s\S]*?)\]/.exec(ingestionModule)?.[1] ?? '';

    expect(ingestionModule).toContain(
      "import { SensorMetricWriterModule } from './sensor-metric-writer.module'",
    );
    expect(ingestionModule).not.toContain(
      "import { SensorMetricWriterService } from './sensor-metric-writer.service'",
    );
    expect(exportsBlock).not.toContain('SensorMetricWriterService');
  });

  it('provides the controller-scoped admin guard event dependency in ImpersonationModule', () => {
    const impersonationModule = read(
      'apps/admin-api-service/src/impersonation/impersonation.module.ts',
    );
    const providersBlock = /providers:\s*\[([\s\S]*?)\]/.exec(impersonationModule)?.[1] ?? '';

    expect(impersonationModule).toContain(
      "import { SecurityEventService } from '@aquaculture/backend-common/security'",
    );
    expect(providersBlock).toContain('SecurityEventService');
  });
});
