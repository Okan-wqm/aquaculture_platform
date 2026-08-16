import { Role } from '@aquaculture/backend-common/decorators';
import { ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';
import { ReceiveDeliveryHandler } from '../handlers/receive-delivery.handler';
import type { StockMovementService } from '../services/stock-movement.service';

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _dataSource: unknown,
      _schema: string,
      _tenantId: string,
      callback: (runner: { manager: EntityManager }) => Promise<unknown>,
    ) => callback({ manager: globalThis.__receiptAuthorityManager }),
  ),
}));

declare global {
  var __receiptAuthorityManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const PO_ID = '44444444-4444-4444-8444-444444444444';
const PO_ITEM_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

function command(): ReceiveDeliveryCommand {
  return new ReceiveDeliveryCommand(
    {
      operationId: OPERATION_ID,
      purchaseOrderId: PO_ID,
      storageLocationId: LOCATION,
      items: [
        {
          purchaseOrderItemId: PO_ITEM_ID,
          quantityReceived: 40,
          lotNumber: 'LOT-9',
          expiryDate: '2027-01-01',
        },
      ],
    },
    TENANT,
    USER,
    [Role.MODULE_MANAGER],
    ['site-1'],
  );
}

describe('ReceiveDeliveryHandler', () => {
  beforeEach(() => {
    globalThis.__receiptAuthorityManager = mock<EntityManager>({});
  });

  it('is a tenant-transaction adapter to the sole purchase-order receipt authority', async () => {
    const receipt = mock<PurchaseOrder>({
      id: PO_ID,
      tenantId: TENANT,
      status: PurchaseOrderStatus.PARTIALLY_RECEIVED,
    });
    const recordPurchaseOrderReceipt = jest.fn().mockResolvedValue(receipt);
    const handler = new ReceiveDeliveryHandler(
      mock<DataSource>({}),
      mock<StockMovementService>({ recordPurchaseOrderReceipt }),
    );

    await expect(handler.execute(command())).resolves.toBe(receipt);
    expect(recordPurchaseOrderReceipt).toHaveBeenCalledWith(
      globalThis.__receiptAuthorityManager,
      command().input,
      {
        tenantId: TENANT,
        userId: USER,
        siteAuthorization: {
          sub: USER,
          roles: [Role.MODULE_MANAGER],
          assignedSiteIds: ['site-1'],
        },
      },
    );
  });

  it('propagates payload-drift conflicts so the tenant transaction rolls back', async () => {
    const recordPurchaseOrderReceipt = jest
      .fn()
      .mockRejectedValue(new ConflictException('operation payload drift'));
    const handler = new ReceiveDeliveryHandler(
      mock<DataSource>({}),
      mock<StockMovementService>({ recordPurchaseOrderReceipt }),
    );

    await expect(handler.execute(command())).rejects.toBeInstanceOf(ConflictException);
  });
});
