/**
 * BulkCreateFromTemplateHandler Unit Tests
 *
 * Verifies the tenant-scoped transactional contract: template lookup,
 * additive vs overwrite mode, bulk save inside runInTenantTransaction,
 * and post-commit cache invalidation.
 */
import { NotFoundException } from '@nestjs/common';

import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { BulkCreateFromTemplateCommand } from '../commands/bulk-create-from-template.command';
import { getTemplateById } from '../data/parameter-templates.data';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { BulkCreateFromTemplateHandler } from '../handlers/bulk-create-from-template.handler';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';

describe('BulkCreateFromTemplateHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'user-001';
  const templateId = 'salmon_freshwater';

  function setup(): {
    handler: BulkCreateFromTemplateHandler;
    mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
    mockQueryRunner: ReturnType<typeof createMockDataSource>['mockQueryRunner'];
    configRepository: ReturnType<typeof createMockRepository<WaterQualityParameterConfig>>;
    invalidate: jest.SpyInstance<void, [string]>;
  } {
    const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
    const configRepository = createMockRepository<WaterQualityParameterConfig>();
    const configCache = new ParameterConfigCacheService(
      createMockRepository<WaterQualityParameterConfig>(),
    );
    const invalidate = jest.spyOn(configCache, 'invalidate').mockImplementation(() => undefined);

    const handler = new BulkCreateFromTemplateHandler(
      configRepository,
      configCache,
      mockDataSource,
    );

    return { handler, mockManager, mockQueryRunner, configRepository, invalidate };
  }

  it('bulk-creates template configs through the tenant transaction in additive mode and invalidates cache', async () => {
    const { handler, mockManager, mockQueryRunner, configRepository, invalidate } = setup();
    // additive mode: no existing codes
    configRepository.find.mockResolvedValueOnce([]);
    (mockManager.save as jest.Mock).mockImplementationOnce((entities: unknown[]) =>
      Promise.resolve(entities.map((e, i) => ({ id: `cfg-${i}`, ...(e as object) }))),
    );

    const result = await handler.execute(
      new BulkCreateFromTemplateCommand(tenantId, templateId, false, userId),
    );

    expect(result.length).toBeGreaterThan(0);
    // additive mode must NOT delete existing configs
    expect(mockManager.delete).not.toHaveBeenCalled();
    expect(mockManager.save).toHaveBeenCalledTimes(1);
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    // post-commit side effect runs after the transaction
    expect(invalidate).toHaveBeenCalledWith(tenantId);
  });

  it('upserts template configs by code in overwrite mode — never deletes, preserves custom params', async () => {
    const { handler, mockManager, mockQueryRunner } = setup();
    const templateCode = getTemplateById(templateId)?.parameters[0]?.code;
    if (!templateCode) {
      throw new Error('salmon_freshwater template fixture has no parameters');
    }
    // existing rows: one template-code param the tenant tuned + one custom
    // (non-template) param that must survive the re-apply.
    const tunedTemplateRow = { id: 'cfg-existing', tenantId, code: templateCode, optimalMin: 999 };
    const customRow = { id: 'cfg-custom', tenantId, code: 'CUSTOM_PARAM_NOT_IN_TEMPLATE' };
    (mockManager.find as jest.Mock).mockResolvedValueOnce([tunedTemplateRow, customRow]);
    (mockManager.save as jest.Mock).mockImplementationOnce((entities: unknown[]) => Promise.resolve(entities));

    await handler.execute(new BulkCreateFromTemplateCommand(tenantId, templateId, true, userId));

    // the destructive delete-all is gone
    expect(mockManager.delete).not.toHaveBeenCalled();
    const saved = (mockManager.save as jest.Mock).mock.calls[0][0] as Array<{ id?: string; code: string }>;
    // the custom param is NOT in the save set → left untouched (preserved)
    expect(saved.map((entry) => entry.code)).not.toContain('CUSTOM_PARAM_NOT_IN_TEMPLATE');
    // the existing template-code row is updated IN PLACE (keeps its id), not re-inserted
    expect(saved.find((entry) => entry.code === templateCode)?.id).toBe('cfg-existing');
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('throws NotFoundException when the template does not exist and never opens a transaction', async () => {
    const { handler, mockQueryRunner, invalidate } = setup();

    await expect(
      handler.execute(
        new BulkCreateFromTemplateCommand(tenantId, 'does_not_exist', false, userId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mockQueryRunner.startTransaction).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
