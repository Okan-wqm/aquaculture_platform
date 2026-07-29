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

  it('routes every operation through ONE scope resolver', () => {
    // Three operations, one place that decides whose rows they touch. A second
    // resolution path is how "explicit target requires platform admin" would
    // end up enforced on the mutation and forgotten on a query.
    const resolutionSites = source.match(/this\.resolveTenantScope\(/g) ?? [];
    expect(resolutionSites).toHaveLength(3);
    expect(source).not.toContain('private getTenantId(');
  });

  it('accepts an explicit tenant target, gated on the platform admin role', () => {
    // The argument that makes config-service able to own tenant configuration:
    // without it, a tenantless SUPER_ADMIN always resolved to SYSTEM and no
    // caller could address another tenant's partition at all.
    expect(source).toContain("@Args('tenantId'");
    expect(source).toMatch(/resolveTenantScope\(context, targetTenantId\)/);
    // Gated, not trusted — a non-admin naming a target is refused rather than
    // narrowed back to its own tenant.
    expect(source).toMatch(/hasPlatformAdminRole\(context\)[\s\S]{0,200}ForbiddenException/);
  });

  it('resolves tenantless platform admins to the SYSTEM scope, gated on the admin role vocabulary', () => {
    // SUPER_ADMIN is the platform's only tenantless principal; its scope is
    // the SYSTEM tenant (platform-scope configuration rows), never a header.
    expect(source).toContain('SYSTEM_TENANT_ID');
    expect(source).toContain('hasPlatformAdminRole');
    // The same role list must gate setConfiguration and the system-scope
    // resolution so the two checks cannot drift apart.
    expect(source).toContain('PLATFORM_ADMIN_ROLES');
  });
});
