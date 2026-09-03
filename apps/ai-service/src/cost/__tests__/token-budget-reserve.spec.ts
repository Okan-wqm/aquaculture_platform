import { TokenBudgetService } from '../token-budget.service';

describe('TokenBudgetService reserve/settle (SEC-MEDIUM-075 — 2026-08-23 scan №20)', () => {
  // The service is constructed WITHOUT Redis (its documented @Optional
  // single-instance fallback) — reserve/settle semantics are identical on
  // both backends; only the counter store differs.
  const service = new TokenBudgetService();

  it('reserves before spend and rejects a reservation that would cross the budget, rolling it back', async () => {
    const tenant = 'reserve-race-tenant';
    await service.addUsage(tenant, 900);

    // 900 spent; reserving 200 more would cross the 1000 budget → reject,
    // and the failed attempt must NOT be charged.
    await expect(service.reserveBudget(tenant, 1000, 200)).rejects.toThrow(/budget exceeded/);
    expect(await service.getUsage(tenant)).toBe(900);

    // A reservation that fits is held, then settled down to actual usage.
    await service.reserveBudget(tenant, 1000, 100);
    expect(await service.getUsage(tenant)).toBe(1000);
    await service.settleReservation(tenant, 100, 60);
    expect(await service.getUsage(tenant)).toBe(960);
  });

  it('concurrent reservations cannot collectively pass the budget (the old check-then-spend race)', async () => {
    const tenant = 'race-tenant';
    await service.addUsage(tenant, 950);
    const budget = 1000;

    // Ten "requests" each reserve 100 concurrently; the budget admits at
    // most 50 more tokens, so every reservation must roll back.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.reserveBudget(tenant, budget, 100)),
    );
    const rejected = attempts.filter((a) => a.status === 'rejected').length;
    expect(rejected).toBe(10);
    expect(await service.getUsage(tenant)).toBe(950);
  });
});
