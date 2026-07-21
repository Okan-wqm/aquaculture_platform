import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { PaymentManagementService } from '../services/payment-management.service';

/**
 * APA-087 — the operator-facing free-text filter must match the human-readable
 * invoice NUMBER (not only transaction id / notes), and the count query must
 * carry the same invoices join as the page query so the total is consistent.
 */
describe('PaymentManagementService.getPayments (APA-087)', () => {
  let service: PaymentManagementService;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn(async (sql: string) => {
      if (/COUNT/i.test(sql)) return [{ count: '0' }];
      return [];
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentManagementService,
        { provide: getDataSourceToken(), useValue: { query } },
      ],
    }).compile();
    service = module.get(PaymentManagementService);
  });

  it('matches invoice_number for a search term and joins invoices on the count query too', async () => {
    await service.getPayments({ search: 'INV-2026' });

    const countCall = query.mock.calls[0] as [string, unknown[]];
    const pageCall = query.mock.calls[1] as [string, unknown[]];

    expect(countCall[0]).toContain('LEFT JOIN billing.invoices');
    expect(countCall[0]).toContain('i.invoice_number ILIKE');
    expect(countCall[1]).toContain('%INV-2026%');

    expect(pageCall[0]).toContain('i.invoice_number ILIKE');
    expect(pageCall[1]).toContain('%INV-2026%');
  });

  it('adds no search predicate when no search term is given', async () => {
    await service.getPayments({});
    const countCall = query.mock.calls[0] as [string, unknown[]];
    expect(countCall[0]).not.toContain('i.invoice_number ILIKE');
  });
});
