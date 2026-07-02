/**
 * Task-domain read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 *
 * Each handler reads through `runInTenantRead`, so the lookup runs on a
 * connection whose search_path + RLS GUC are asserted for the tenant. These
 * tests prove the tenant filter is applied and that by-id reads fail loudly
 * (NotFoundException) rather than returning null/empty.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { GetTaskHandler } from '../handlers/get-task.handler';
import { GetTaskQuery } from '../queries/get-task.query';
import { GetAutoRuleHandler } from '../handlers/get-auto-rule.handler';
import { GetAutoRuleQuery } from '../queries/get-auto-rule.query';
import { GetRecurringTemplateHandler } from '../handlers/get-recurring-template.handler';
import { GetRecurringTemplateQuery } from '../queries/get-recurring-template.query';
import { ListAutoRulesHandler } from '../handlers/list-auto-rules.handler';
import { ListAutoRulesQuery } from '../queries/list-auto-rules.query';
import { ListRecurringTemplatesHandler } from '../handlers/list-recurring-templates.handler';
import { ListRecurringTemplatesQuery } from '../queries/list-recurring-templates.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Task-domain read handlers (fail-closed tenant boundary)', () => {
  describe('GetTaskHandler', () => {
    it('returns the task scoped to the tenant', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'task-1' });

      const result = await new GetTaskHandler(mockDataSource).execute(
        new GetTaskQuery(tenantId, 'task-1'),
      );

      expect(result).toEqual({ id: 'task-1' });
      expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
        where: { id: 'task-1', tenantId },
      });
    });

    it('throws NotFoundException when the task is absent (no silent null)', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        new GetTaskHandler(mockDataSource).execute(new GetTaskQuery(tenantId, 'missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GetAutoRuleHandler', () => {
    it('throws NotFoundException when absent', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        new GetAutoRuleHandler(mockDataSource).execute(new GetAutoRuleQuery(tenantId, 'missing')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GetRecurringTemplateHandler', () => {
    it('throws NotFoundException when absent', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        new GetRecurringTemplateHandler(mockDataSource).execute(
          new GetRecurringTemplateQuery(tenantId, 'missing'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ListAutoRulesHandler', () => {
    it('lists rules scoped to the tenant, newest first', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'r-1' }, { id: 'r-2' }]);

      const result = await new ListAutoRulesHandler(mockDataSource).execute(
        new ListAutoRulesQuery(tenantId),
      );

      expect(result).toHaveLength(2);
      expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
        where: { tenantId },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('ListRecurringTemplatesHandler', () => {
    it('lists templates scoped to the tenant, newest first', async () => {
      const { mockDataSource, mockManager } = createMockDataSource();
      (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 't-1' }]);

      const result = await new ListRecurringTemplatesHandler(mockDataSource).execute(
        new ListRecurringTemplatesQuery(tenantId),
      );

      expect(result).toHaveLength(1);
      expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), {
        where: { tenantId },
        order: { createdAt: 'DESC' },
      });
    });
  });
});
