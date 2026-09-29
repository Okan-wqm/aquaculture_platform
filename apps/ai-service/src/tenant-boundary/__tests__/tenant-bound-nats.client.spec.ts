import { of } from 'rxjs';
import { SecurityEventService, tenantFingerprint } from '@aquaculture/backend-common/security';

import type { TenantBoundToolContext } from '../../tools/core/tool.interface';
import type { TenantFreeFields } from '../tenant-bound-nats.client';
import { TenantBinding } from '../tenant-binding';
import { TenantBoundaryViolation } from '../tenant-boundary-violation';
import { TenantBoundaryViolationReporter } from '../tenant-boundary-violation.reporter';
import {
  TENANT_A,
  TENANT_B,
  boundFailure,
  boundReply,
  humanToolContext,
  tenantBoundClient,
} from './fixtures/tenant-bound.fixture';

const SUBJECT = 'request.farm.ai.getTankCapacity';

/**
 * Compile-time proof (K10 layer 1): request fields that carry a tenant — a
 * hand-built `{ tenantId }` or a full `XRequest` — do not satisfy the client's
 * field type. If TenantFreeFields ever admitted `tenantId`, this assignment
 * stops compiling and the suite fails to build.
 */
type CarriesTenant = { tankId: string; tenantId: string };
const tenantFieldsAreRejected: CarriesTenant extends TenantFreeFields ? 'accepted' : 'rejected' =
  'rejected';
const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number');

/**
 * TenantBoundNatsClient (K10 layers 1 + 3, MT-HIGH-062): the only way tool code
 * reaches another service. It writes the tenant, refuses tenant fields, and
 * refuses — and reports — a reply served for another tenant before the data
 * is read.
 */
describe('TenantBoundNatsClient', () => {
  let send: jest.Mock;
  let publishTenantAccessDenied: jest.Mock;
  let reporter: TenantBoundaryViolationReporter;
  let errorLog: jest.SpyInstance;
  const ctx = humanToolContext({ correlationId: 'corr-7' });

  beforeEach(() => {
    send = jest.fn();
    const securityEvents = new SecurityEventService();
    publishTenantAccessDenied = jest.fn().mockResolvedValue(undefined);
    securityEvents.publishTenantAccessDenied = publishTenantAccessDenied;
    reporter = new TenantBoundaryViolationReporter(securityEvents);
    errorLog = jest.spyOn(reporter['logger'], 'error').mockImplementation(() => undefined);
  });

  const call = (fields: object = { tankId: 't' }) => ({
    subject: SUBJECT,
    fields,
    isData: isNumbers,
    timeoutMs: 1000,
  });

  it('rejects tenant-carrying request fields at compile time', () => {
    expect(tenantFieldsAreRejected).toBe('rejected');
  });

  it('writes the bound tenant into the request and returns same-tenant data', async () => {
    send.mockReturnValue(of(boundReply([1, 2])));
    await expect(tenantBoundClient({ send }, reporter).request(ctx, call())).resolves.toEqual([
      1, 2,
    ]);
    expect(send).toHaveBeenCalledWith(SUBJECT, { tankId: 't', tenantId: TENANT_A });
  });

  it('refuses a reply served for another tenant, reports it PII-free, and never returns its data', async () => {
    // SCENARIO: the reply carries tenant B's rows and names tenant B.
    // EXPECTS: TenantBoundaryViolation(reply_tenant_mismatch); one security event naming only ids.
    send.mockReturnValue(of(boundReply([4, 2], TENANT_B)));

    const outcome = tenantBoundClient({ send }, reporter).request(ctx, call());

    await expect(outcome).rejects.toMatchObject({
      code: 'tenant_mismatch',
      reason: 'reply_tenant_mismatch',
    });
    expect(publishTenantAccessDenied).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      correlationId: 'corr-7',
      // V-T1a-10: tenant A's event names B only by fingerprint, never by UUID.
      requestedTenantId: tenantFingerprint(TENANT_B),
      reason: `ai_tool_reply_tenant_mismatch:${SUBJECT}`,
    });
    expect(JSON.stringify(publishTenantAccessDenied.mock.calls)).not.toContain(TENANT_B);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain('u-1');
    expect(logged).not.toContain('4,2');
  });

  it('treats a failure reply naming another tenant as a violation too', async () => {
    send.mockReturnValue(of(boundFailure('NOT_FOUND', TENANT_B)));
    await expect(tenantBoundClient({ send }, reporter).request(ctx, call())).rejects.toBeInstanceOf(
      TenantBoundaryViolation,
    );
  });

  it('refuses tenant or schema fields smuggled past the type (e.g. through a cast) before sending', async () => {
    // SCENARIO: a caller defeats the TenantFreeFields constraint with an intermediate `object`.
    // EXPECTS: violation, nothing sent.
    const smuggled: object = { tankId: 't', tenantId: TENANT_B };
    await expect(
      tenantBoundClient({ send }, reporter).request(ctx, call(smuggled)),
    ).rejects.toMatchObject({ reason: 'tenant_field_in_request' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a context whose binding is a structural copy', async () => {
    // SCENARIO: a structured clone of a genuine tenant-B binding — TypeScript still calls it a
    //           TenantBinding, but the ES private brand did not survive the copy.
    // EXPECTS: violation(forged_binding) before anything is sent.
    const forged: TenantBoundToolContext = {
      ...ctx,
      tenant: structuredClone(TenantBinding.fromTrustedRequest(TENANT_B)),
    };
    await expect(
      tenantBoundClient({ send }, reporter).request(forged, call()),
    ).rejects.toMatchObject({
      reason: 'forged_binding',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: true, data: [1, 2] }, 'an envelope without tenantId'],
    [[1, 2], 'a bare array'],
    [{ ok: true, tenantId: 42, data: [1] }, 'a non-string tenant'],
  ])('stops the run and reports a reply that names no tenant: %j (%s)', async (reply, _shape) => {
    // SCENARIO: a responder (or anything on the inbox) answers without the tenant-bound envelope.
    // EXPECTS: TenantBoundaryViolation(reply_without_tenant), one security event, no data returned.
    send.mockReturnValue(of(reply));
    await expect(tenantBoundClient({ send }, reporter).request(ctx, call())).rejects.toMatchObject({
      code: 'tenant_mismatch',
      reason: 'reply_without_tenant',
    });
    expect(publishTenantAccessDenied).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, requestedTenantId: 'none' }),
    );
  });

  it('keeps the raw transport out of reach: no property of the client leads to it', () => {
    // SCENARIO (V-T1a-3): tool code tries `client['transport'].send(...)` to skip the tenant check.
    // EXPECTS: the transport is an ES private field — no own or prototype property exposes it.
    const client = tenantBoundClient({ send }, reporter);
    expect(Reflect.get(client, 'transport')).toBeUndefined();
    expect(Object.values(client)).not.toContainEqual(expect.objectContaining({ send }));
  });

  it.each([
    [boundFailure('NOT_FOUND'), /No record with that id exists/],
    [boundFailure('INVALID_REQUEST'), /rejected as invalid/],
    [boundFailure('INTERNAL_ERROR'), /temporarily unavailable/],
    [boundReply(['x']), /contract guard/],
  ])('turns same-tenant failure %j into an ordinary error', async (reply, message) => {
    send.mockReturnValue(of(reply));
    const outcome = tenantBoundClient({ send }, reporter).request(ctx, call());
    await expect(outcome).rejects.toThrow(message);
    await expect(outcome).rejects.not.toBeInstanceOf(TenantBoundaryViolation);
    expect(publishTenantAccessDenied).not.toHaveBeenCalled();
  });
});
