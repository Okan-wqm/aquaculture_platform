import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../../..');

const RETIRED_AUTHORITY_FILES = [
  'apps/config-service/src/configuration/commands/create-configuration.command.ts',
  'apps/config-service/src/configuration/commands/delete-configuration.command.ts',
  'apps/config-service/src/configuration/commands/update-configuration.command.ts',
  'apps/config-service/src/configuration/commands/upsert-configuration.command.ts',
  'apps/config-service/src/configuration/dto/create-configuration.input.ts',
  'apps/config-service/src/configuration/dto/effective-configuration.dto.ts',
  'apps/config-service/src/configuration/handlers/create-configuration.handler.ts',
  'apps/config-service/src/configuration/handlers/delete-configuration.handler.ts',
  'apps/config-service/src/configuration/handlers/update-configuration.handler.ts',
  'apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts',
  'apps/config-service/src/configuration/queries/get-configuration.query.ts',
  'apps/config-service/src/configuration/queries/get-configurations.query.ts',
  'apps/admin-api-service/src/settings/settings.controller.ts',
  'apps/admin-api-service/src/settings/services/system-setting.service.ts',
  'apps/admin-api-service/src/settings/entities/system-setting.entity.ts',
  'apps/admin-api-service/src/system-management/entities/global-config.entity.ts',
  'web/modules/admin-panel/src/pages/ProvisioningSettingsPage.tsx',
] as const;

const ACTIVE_SURFACE_FILES = [
  'apps/config-service/src/configuration/configuration.resolver.ts',
  'apps/config-service/src/configuration/configuration.module.ts',
  'apps/admin-api-service/src/settings/settings.module.ts',
  'apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts',
  'web/modules/admin-panel/src/Module.tsx',
  'web/modules/admin-panel/src/graphql/platform-configuration-operations.ts',
  'web/modules/admin-panel/src/services/api/settings.ts',
] as const;

describe('single configuration mutation authority closure', () => {
  it('keeps every retired generic authority physically absent', () => {
    const survivors = RETIRED_AUTHORITY_FILES.filter((relativePath) =>
      existsSync(resolve(REPO_ROOT, relativePath)),
    );
    expect(survivors).toEqual([]);
  });

  it('exposes only snapshot read and atomic batch mutation on the GraphQL authority', () => {
    const resolver = source('apps/config-service/src/configuration/configuration.resolver.ts');
    const operationNames = [...resolver.matchAll(/name:\s*'([^']+)'/gu)]
      .map((match) => match[1])
      .sort();
    expect(operationNames).toEqual(['applyConfigurationBatch', 'configurationSnapshot']);
    expect(resolver).not.toMatch(/\b(?:create|update|upsert|delete|set)Configuration\s*\(/u);
    expect(resolver).not.toMatch(/effectiveConfigurationsByService/u);
  });

  it('does not reintroduce legacy REST paths, entities, services, or frontend wrappers', () => {
    const activeSurface = ACTIVE_SURFACE_FILES.map(
      (relativePath) => `${relativePath}\n${source(relativePath)}`,
    ).join('\n');
    const retiredContracts = [
      /\/settings\/config\/email\/test/u,
      /\/settings\/system\/info/u,
      /\/system\/settings\/configs/u,
      /provisioning-config/u,
      /\bSystemSettingService\b/u,
      /\bGlobalConfig\b/u,
      /\bProvisioningSettingsPage\b/u,
      /\b(?:create|update|upsert|delete|set)Configuration\s*\(/u,
      /effectiveConfigurationsByService/u,
    ];
    for (const retiredContract of retiredContracts) {
      expect(activeSurface).not.toMatch(retiredContract);
    }
  });
});

function source(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}
