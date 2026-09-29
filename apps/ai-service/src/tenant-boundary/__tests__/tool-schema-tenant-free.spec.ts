import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ToolExecutionAudit } from '../../audit/tool-execution-audit.entity';
import { AquacultureMathToolsModule } from '../../tools/aquaculture-math/aquaculture-math-tools.module';
import { Tool } from '../../tools/core/tool.decorator';
import { BaseTool } from '../../tools/core/base-tool';
import { FarmToolsModule } from '../../tools/farm/farm-tools.module';
import { SensorConfigToolsModule } from '../../tools/sensor-config/sensor-config-tools.module';
import { ToolRegistryModule } from '../../tools/tool-registry.module';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { WaterChemistryToolsModule } from '../../tools/water-chemistry/water-chemistry-tools.module';
import { AI_TENANT_BOUND_TRANSPORT } from '../tenant-bound-nats.client';
import { findTenantScopedParameters } from '../tenant-scoped-keys';

const AUDIT_REPO_STUB = { create: jest.fn(), save: jest.fn(), find: jest.fn() };
const TOOL_MODULES = [
  WaterChemistryToolsModule,
  SensorConfigToolsModule,
  FarmToolsModule,
  AquacultureMathToolsModule,
];

/**
 * Every tool name declared with `@Tool({ name: '…' })` in ai-service's non-test
 * sources. WHY: the walk below composes TOOL_MODULES by hand; comparing its
 * registry against the source makes a tool in a module missing from that list
 * fail here instead of escaping the check.
 */
function declaredToolNames(dir = resolve(__dirname, '../../tools')): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : declaredToolNames(path);
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) return [];
    const text = readFileSync(path, 'utf-8');
    return [...text.matchAll(/^@Tool\(\{\s*name:\s*'([^']+)'/gm)].map((m) => m[1] ?? '');
  });
}

/**
 * K10 layer 2 (MT-HIGH-062): no registered tool offers the model a parameter
 * that names a tenant or a schema. Walks EVERY tool the app composes (the real
 * modules, real discovery) and proves that set is every tool declared in source.
 */
describe('registered tool schemas are tenant-free (K10)', () => {
  it('no registered tool schema has a tenant/tenantId/tenant_id/schema/search_path parameter at any depth', async () => {
    // SCENARIO: compose the app's tool modules and read every definition the model can be offered.
    // EXPECTS: at least the known tool set is present, and none offers a tenant/schema selector.
    const moduleRef = await Test.createTestingModule({
      imports: [ToolRegistryModule, ...TOOL_MODULES],
    })
      .overrideProvider(getRepositoryToken(ToolExecutionAudit))
      .useValue(AUDIT_REPO_STUB)
      .overrideProvider(AI_TENANT_BOUND_TRANSPORT)
      .useValue({ send: jest.fn() })
      .compile();
    await moduleRef.init();

    const metadata = moduleRef.get(ToolRegistryService).getAllMetadata();
    expect(metadata.length).toBeGreaterThanOrEqual(59);
    expect(metadata.map((tool) => tool.name).sort()).toEqual(declaredToolNames().sort());
    const offenders = metadata
      .map((tool) => ({ tool: tool.name, params: findTenantScopedParameters(tool.inputSchema) }))
      .filter((entry) => entry.params.length > 0);
    expect(offenders).toEqual([]);

    await moduleRef.close();
  });

  it('the registry refuses to boot with a tool that offers a tenant parameter', async () => {
    // SCENARIO: a tool whose schema nests a `tenant_id` filter.
    // EXPECTS: module init throws — such a tool cannot be deployed at all.
    @Tool({
      name: 'leaky_probe',
      description: 'probe',
      category: 'farm_query',
      runtime: 'cloud',
      requiredPermissions: ['operator'],
      requiresModule: null,
      requiresConfirmation: false,
      inputSchema: {
        type: 'object',
        properties: { filter: { type: 'object', properties: { tenant_id: { type: 'string' } } } },
      },
    })
    class LeakyProbeTool extends BaseTool<Record<string, never>, string> {
      protected async run(): Promise<string> {
        return 'never';
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ToolRegistryModule],
      providers: [LeakyProbeTool],
    })
      .overrideProvider(getRepositoryToken(ToolExecutionAudit))
      .useValue(AUDIT_REPO_STUB)
      .compile();

    await expect(moduleRef.init()).rejects.toThrow(/leaky_probe.*filter\.tenant_id/);
  });
});
