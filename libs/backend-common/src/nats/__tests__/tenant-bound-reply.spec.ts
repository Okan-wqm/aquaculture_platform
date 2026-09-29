import { Logger, NotFoundException } from '@nestjs/common';

import { getRequestContext } from '../../logging/request-context';
import { respondTenantBound } from '../tenant-bound-reply';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'request.farm.ai.getFishHealthStats';

/**
 * The shared responder skeleton for every AI-facing subject (K10 /
 * MT-HIGH-062): guard → handle in the tenant frame → tenant-bound envelope,
 * never a throw into the reply channel.
 */
describe('respondTenantBound', () => {
  const logger = new Logger('spec');
  const isReq = (v: unknown): v is { tenantId: string; x: number } =>
    typeof v === 'object' && v !== null && typeof (v as { x?: unknown }).x === 'number';

  beforeEach(() => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('rejects a payload that fails the contract guard without calling the handler, echoing a valid tenant', async () => {
    // SCENARIO: a request whose tenant is valid but whose fields fail the guard.
    // EXPECTS: INVALID_REQUEST naming that tenant; the handler never runs.
    const handle = jest.fn();
    const reply = await respondTenantBound(logger, SUBJECT, { tenantId: TENANT }, isReq, handle);
    expect(reply).toEqual({ ok: false, tenantId: TENANT, error: 'INVALID_REQUEST' });
    expect(handle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('names no tenant when the payload tenant is not a UUID, even if the guard passes', async () => {
    // SCENARIO: a guard that forgets to check the tenant; the tenant is garbage.
    // EXPECTS: INVALID_REQUEST with tenantId null — the skeleton validates the tenant itself.
    const handle = jest.fn();
    const reply = await respondTenantBound(logger, SUBJECT, { tenantId: 't', x: 1 }, isReq, handle);
    expect(reply).toEqual({ ok: false, tenantId: null, error: 'INVALID_REQUEST' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('runs the handler inside the tenant frame and names that same tenant in the reply', async () => {
    // SCENARIO: a valid request; the handler reports the tenant its ambient frame carries.
    // EXPECTS: the reply tenant equals the tenant the handler ran under; the frame is gone afterwards.
    expect(getRequestContext().tenantId).toBeUndefined();
    const reply = await respondTenantBound(logger, SUBJECT, { tenantId: TENANT, x: 1 }, isReq, () =>
      Promise.resolve({ seenTenant: getRequestContext().tenantId }),
    );
    expect(reply).toEqual({ ok: true, tenantId: TENANT, data: { seenTenant: TENANT } });
    expect(getRequestContext().tenantId).toBeUndefined();
  });

  it('turns a NotFoundException into NOT_FOUND — an id from another tenant does not exist here', async () => {
    // SCENARIO: the handler looks up an id that is not in this tenant's schema.
    // EXPECTS: NOT_FOUND for the requesting tenant, no error log (not a fault).
    const reply = await respondTenantBound(logger, SUBJECT, { tenantId: TENANT, x: 1 }, isReq, () =>
      Promise.reject(new NotFoundException('Tank not found')),
    );
    expect(reply).toEqual({ ok: false, tenantId: TENANT, error: 'NOT_FOUND' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('turns any other failure into INTERNAL_ERROR and logs it structurally — never throws', async () => {
    // SCENARIO: the handler crashes.
    // EXPECTS: INTERNAL_ERROR for the requesting tenant plus one structured error log.
    const reply = await respondTenantBound(logger, SUBJECT, { tenantId: TENANT, x: 1 }, isReq, () =>
      Promise.reject(new Error('db down')),
    );
    expect(reply).toEqual({ ok: false, tenantId: TENANT, error: 'INTERNAL_ERROR' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ subject: SUBJECT, error: 'db down' }),
    );
  });
});
