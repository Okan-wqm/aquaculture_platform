import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { SensorRoutesController } from './sensor.routes';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function response(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

describe('SensorRoutesController impersonation boundary', () => {
  const controller = new SensorRoutesController(new ConfigService());

  it('lets Nest preserve authentication errors instead of translating them to 502', async () => {
    const res = response();
    const req = {
      headers: {},
    } as unknown as Request;

    await expect(controller.getMqttStatus(req, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized export before opening a downstream request', async () => {
    const res = response();
    const req = {
      params: { sensorId: 'sensor-1' },
      query: {},
      headers: {},
      user: {
        sub: '22222222-2222-4222-8222-222222222222',
        roles: ['SUPER_ADMIN'],
        mfaVerified: true,
      },
      effectiveTenantId: TENANT_ID,
      impersonationSessionId: '33333333-3333-4333-8333-333333333333',
      impersonationPermissions: {
        canViewData: true,
        canModifyData: false,
        canAccessSettings: false,
        canManageUsers: false,
        canViewBilling: false,
        canExportData: false,
        allowedModules: ['sensor'],
      },
    } as unknown as Request;

    await expect(controller.exportData(req, res)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(res.status).not.toHaveBeenCalled();
  });
});
