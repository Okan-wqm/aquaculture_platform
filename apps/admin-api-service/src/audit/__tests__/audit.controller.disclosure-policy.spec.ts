import type { Request } from 'express';

import { AuditLogController } from '../audit.controller';
import type { AuditLogService } from '../audit.service';

const ENTITY_ID = '11111111-1111-4111-8111-111111111111';

function authenticatedRequest(): Request {
  return {
    user: {
      id: '22222222-2222-4222-8222-222222222222',
      sub: '22222222-2222-4222-8222-222222222222',
      email: 'admin@example.com',
    },
    headers: {},
    socket: {},
  } as unknown as Request;
}

describe('AuditLogController disclosure policy', () => {
  it('does not execute a sensitive read when its mandatory meta-audit append fails', async () => {
    const service = {
      appendBeforeDisclosure: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      getEntityHistory: jest.fn(),
    };
    const controller = new AuditLogController(service as unknown as AuditLogService);

    await expect(
      controller.getEntityHistory(authenticatedRequest(), 'Tenant', ENTITY_ID),
    ).rejects.toThrow('audit unavailable');

    expect(service.getEntityHistory).not.toHaveBeenCalled();
  });

  it('commits meta-audit evidence before loading the protected projection', async () => {
    const order: string[] = [];
    const service = {
      appendBeforeDisclosure: jest.fn(async () => {
        order.push('audit');
      }),
      getEntityHistory: jest.fn(async () => {
        order.push('read');
        return [];
      }),
    };
    const controller = new AuditLogController(service as unknown as AuditLogService);

    await expect(
      controller.getEntityHistory(authenticatedRequest(), 'Tenant', ENTITY_ID),
    ).resolves.toEqual([]);

    expect(order).toEqual(['audit', 'read']);
  });

  it('does not query or disclose an export when mandatory evidence persistence fails', async () => {
    const service = {
      appendBeforeDisclosure: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      getExportRows: jest.fn(),
    };
    const response = {
      end: jest.fn(),
      setHeader: jest.fn(),
      getHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    const controller = new AuditLogController(service as unknown as AuditLogService);

    await expect(
      controller.exportAuditLogs(
        authenticatedRequest(),
        {},
        response as unknown as import('express').Response,
      ),
    ).rejects.toThrow('audit unavailable');

    expect(service.getExportRows).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});
