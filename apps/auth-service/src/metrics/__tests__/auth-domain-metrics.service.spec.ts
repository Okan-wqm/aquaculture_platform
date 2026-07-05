/**
 * AuthDomainMetricsService unit tests (PERF-MEDIUM-003).
 *
 * Pins the tier-0 auth latency histogram (auth_operation_duration_seconds): login
 * and token-validation are GraphQL operations on /graphql, so the route-blind
 * platform HTTP histogram cannot isolate them — this dedicated series is the only
 * thing the SLO can alert on. Direct instantiation (no Nest DI), onModuleInit /
 * onModuleDestroy called manually, registry read back via getMetrics().
 */
import { AuthDomainMetricsService } from '../auth-domain-metrics.service';

describe('AuthDomainMetricsService (PERF-MEDIUM-003)', () => {
  let service: AuthDomainMetricsService;

  beforeEach(() => {
    service = new AuthDomainMetricsService();
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records login latency with operation + outcome labels (no tenant label)', async () => {
    service.startOperation('login')('success');
    const dump = await service.getMetrics();
    expect(dump).toContain('auth_operation_duration_seconds_count');
    expect(dump).toMatch(
      /auth_operation_duration_seconds_count\{[^}]*operation="login"[^}]*outcome="success"[^}]*\}\s+1/,
    );
    // Scrape surface is unauthenticated — a tenant label would enable enumeration.
    expect(dump).not.toContain('tenant');
  });

  it('counts a FAILED operation under outcome="error" (brute-force probes are part of the SLI)', async () => {
    service.startOperation('login')('error');
    const dump = await service.getMetrics();
    expect(dump).toMatch(
      /auth_operation_duration_seconds_count\{[^}]*operation="login"[^}]*outcome="error"[^}]*\}\s+1/,
    );
  });

  it('distinguishes token_validation from login on the same histogram', async () => {
    service.startOperation('token_validation')('success');
    service.startOperation('login')('success');
    const dump = await service.getMetrics();
    expect(dump).toMatch(/operation="token_validation"/);
    expect(dump).toMatch(/operation="login"/);
  });

  it('observes a non-negative duration into the histogram sum', async () => {
    service.startOperation('token_validation')('success');
    const dump = await service.getMetrics();
    const sum = dump.match(
      /auth_operation_duration_seconds_sum\{[^}]*operation="token_validation"[^}]*\}\s+([0-9.e-]+)/,
    );
    expect(sum).not.toBeNull();
    expect(Number(sum?.[1])).toBeGreaterThanOrEqual(0);
  });
});
