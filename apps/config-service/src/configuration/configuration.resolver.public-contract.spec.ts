import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ConfigurationResolver public GraphQL contract', () => {
  const source = readFileSync(
    resolve(__dirname, 'configuration.resolver.ts'),
    'utf8',
  );

  it('exposes only effective runtime configuration operations', () => {
    expect(source).toContain("name: 'effectiveConfiguration'");
    expect(source).toContain("name: 'effectiveConfigurationsByService'");
    expect(source).toContain('setConfiguration');

    for (const rawOperation of [
      "name: 'configuration'",
      "name: 'configurationById'",
      "name: 'configurations'",
      "name: 'configurationsByService'",
      "name: 'configurationHistory'",
      'createConfiguration',
      'updateConfiguration',
      'deleteConfiguration',
    ]) {
      expect(source).not.toContain(rawOperation);
    }
  });

  it('keeps raw Configuration entities out of the public resolver surface', () => {
    expect(source).toContain('@Resolver(() => EffectiveConfigurationDto)');
    expect(source).not.toContain('@Resolver(() => Configuration)');
    expect(source).not.toMatch(/@Query\(\(\)\s*=>\s*Configuration\b/);
    expect(source).not.toMatch(/@Mutation\(\(\)\s*=>\s*Configuration\b/);
  });

  it('derives tenant and actor exclusively from verified GraphQL user context', () => {
    expect(source).toContain('context.req.user?.tenantId');
    expect(source).toContain('context.req.user?.sub');
    expect(source).not.toMatch(/headers\s*\[\s*['"]x-tenant-id['"]\s*\]/);
    expect(source).not.toContain('@Headers');
  });
});
