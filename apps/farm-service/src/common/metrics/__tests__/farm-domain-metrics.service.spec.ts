/**
 * FarmDomainMetricsService Unit Tests
 *
 * Exercises every counter / histogram exposed by the service and
 * confirms the Prometheus text output carries the expected label
 * sets. Uses a direct instantiation (no Nest DI) and calls
 * onModuleInit / onModuleDestroy manually so the tests are
 * independent of the module life-cycle.
 */
import { FarmDomainMetricsService } from '../farm-domain-metrics.service';

describe('FarmDomainMetricsService', () => {
  let service: FarmDomainMetricsService;

  beforeEach(() => {
    service = new FarmDomainMetricsService();
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records mutation duration with operation + outcome + tenant labels', async () => {
    service.recordMutation({
      operation: 'createBatch',
      durationSeconds: 0.12,
      outcome: 'success',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    service.recordMutation({
      operation: 'createBatch',
      durationSeconds: 0.08,
      outcome: 'error',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_mutation_duration_seconds_count');
    expect(dump).toContain('operation="createBatch"');
    expect(dump).toContain('outcome="success"');
    expect(dump).toContain('outcome="error"');
    expect(dump).toContain('tenant="11111111"');
  });

  it('records mutation errors with classified error_class', async () => {
    service.recordMutationError({
      operation: 'closeBatch',
      errorClass: 'BadRequestException',
    });
    service.recordMutationError({
      operation: 'closeBatch',
      errorClass: 'BadRequestException',
    });
    service.recordMutationError({
      operation: 'createHarvestRecord',
      errorClass: 'ConflictException',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_mutation_errors_total');
    expect(dump).toMatch(
      /farm_mutation_errors_total\{operation="closeBatch",error_class="BadRequestException"[^}]*} 2/,
    );
    expect(dump).toMatch(
      /farm_mutation_errors_total\{operation="createHarvestRecord",error_class="ConflictException"[^}]*} 1/,
    );
  });

  it('records capacity blocks with mode + axis', async () => {
    service.incCapacityBlock({ mode: 'hard', axis: 'biomass' });
    service.incCapacityBlock({
      mode: 'admin_override',
      axis: 'density',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_capacity_block_total');
    expect(dump).toContain('mode="hard"');
    expect(dump).toContain('mode="admin_override"');
    expect(dump).toContain('axis="biomass"');
    expect(dump).toContain('axis="density"');
  });

  it('records withdrawal blocks by surface', async () => {
    service.incWithdrawalBlock({ surface: 'close_batch' });
    service.incWithdrawalBlock({ surface: 'harvest_record' });
    service.incWithdrawalBlock({ surface: 'harvest_record' });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_withdrawal_block_total');
    expect(dump).toMatch(
      /farm_withdrawal_block_total\{[^}]*surface="close_batch"[^}]*} 1/,
    );
    expect(dump).toMatch(
      /farm_withdrawal_block_total\{[^}]*surface="harvest_record"[^}]*} 2/,
    );
  });

  it('records backdate rejections by context', async () => {
    service.incBackdateRejection({ context: 'feeding' });
    service.incBackdateRejection({ context: 'mortality' });
    service.incBackdateRejection({ context: 'feeding' });
    const dump = await service.getMetrics();
    expect(dump).toContain('farm_backdate_rejected_total');
    expect(dump).toMatch(
      /farm_backdate_rejected_total\{[^}]*context="feeding"[^}]*} 2/,
    );
    expect(dump).toMatch(
      /farm_backdate_rejected_total\{[^}]*context="mortality"[^}]*} 1/,
    );
  });

  it('labels unknown tenant as "unknown" instead of empty string', async () => {
    service.recordMutation({
      operation: 'noTenant',
      durationSeconds: 0.01,
      outcome: 'success',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('tenant="unknown"');
  });

  it('truncates tenant UUIDs to the first 8 chars to bound label cardinality', async () => {
    service.recordMutation({
      operation: 'cardinalityCheck',
      durationSeconds: 0.01,
      outcome: 'success',
      tenantId: 'abcdef12-3456-4789-8abc-def123456789',
    });
    const dump = await service.getMetrics();
    expect(dump).toContain('tenant="abcdef12"');
    expect(dump).not.toContain('abcdef12-3456-4789-8abc-def123456789');
  });

  it('exposes the correct Prometheus content-type', () => {
    expect(service.getContentType()).toMatch(/^text\/plain/);
  });
});
