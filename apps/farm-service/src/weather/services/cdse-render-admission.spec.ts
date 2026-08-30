import {
  CDSE_RENDER_GLOBAL_CONCURRENCY,
  CDSE_RENDER_GLOBAL_QUEUE_LIMIT,
  CDSE_RENDER_REDIS_TIMEOUT_MS,
  CDSE_RENDER_TENANT_CONCURRENCY,
  CDSE_RENDER_TENANT_QUEUE_LIMIT,
  CdseRenderAdmission,
  CdseRenderAdmissionError,
} from './cdse-render-admission';

describe('CdseRenderAdmission', () => {
  afterEach(() => jest.useRealTimers());

  it('bounds active and queued work per tenant and drains on release', async () => {
    const admission = new CdseRenderAdmission();
    const active = await Promise.all(
      Array.from({ length: CDSE_RENDER_TENANT_CONCURRENCY }, (_, index) =>
        admission.acquire('tenant-a', `active-${index}`),
      ),
    );
    const queued = Array.from({ length: CDSE_RENDER_TENANT_QUEUE_LIMIT }, (_, index) =>
      admission.acquire('tenant-a', `queued-${index}`),
    );

    await expect(admission.acquire('tenant-a', 'overflow')).rejects.toMatchObject({
      reason: 'SATURATED',
    });

    active[0]!();
    const firstQueuedRelease = await queued[0]!;
    firstQueuedRelease();
    active[1]!();
    const secondQueuedRelease = await queued[1]!;
    secondQueuedRelease();
  });

  it('enforces one process-wide global queue across tenants', async () => {
    const admission = new CdseRenderAdmission();
    const active = await Promise.all(
      Array.from({ length: CDSE_RENDER_GLOBAL_CONCURRENCY }, (_, index) =>
        admission.acquire(`tenant-${index}`, `active-${index}`),
      ),
    );
    const queued = Array.from({ length: CDSE_RENDER_GLOBAL_QUEUE_LIMIT }, (_, index) =>
      admission.acquire(`tenant-${index % CDSE_RENDER_GLOBAL_CONCURRENCY}`, `queued-${index}`),
    );

    await expect(admission.acquire('another-tenant', 'overflow')).rejects.toBeInstanceOf(
      CdseRenderAdmissionError,
    );
    await expect(admission.acquire('another-tenant', 'overflow')).rejects.toMatchObject({
      reason: 'SATURATED',
    });

    active.forEach((release) => release());
    const firstWave = await Promise.all(queued.slice(0, CDSE_RENDER_GLOBAL_CONCURRENCY));
    firstWave.forEach((release) => release());
    const secondWave = await Promise.all(queued.slice(CDSE_RENDER_GLOBAL_CONCURRENCY));
    secondWave.forEach((release) => release());
  });

  it('suppresses an identical active or queued flight key', async () => {
    const admission = new CdseRenderAdmission();
    const release = await admission.acquire('tenant-a', 'same-flight');

    await expect(admission.acquire('tenant-a', 'same-flight')).rejects.toMatchObject({
      reason: 'DUPLICATE',
    });

    release();
    const secondRelease = await admission.acquire('tenant-a', 'same-flight');
    secondRelease();
  });

  it('removes an aborted queued flight and admits the same key later', async () => {
    const admission = new CdseRenderAdmission();
    const first = await admission.acquire('tenant-a', 'active-1');
    const second = await admission.acquire('tenant-a', 'active-2');
    const controller = new AbortController();
    const queued = admission.acquire('tenant-a', 'aborted-flight', controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ reason: 'CANCELLED' });

    first();
    const replacement = await admission.acquire('tenant-a', 'aborted-flight');
    replacement();
    second();
  });

  it('fails closed within a bounded deadline when distributed admission stalls', async () => {
    jest.useFakeTimers();
    const redis = {
      eval: jest.fn(() => new Promise<unknown>(() => undefined)),
    };
    const admission = new CdseRenderAdmission(redis, true);

    const acquiring = admission.acquire('tenant-a', 'stalled-flight');
    const rejection = expect(acquiring).rejects.toMatchObject({ reason: 'UNAVAILABLE' });
    await jest.advanceTimersByTimeAsync(CDSE_RENDER_REDIS_TIMEOUT_MS);
    await rejection;
  });

  it('releases a distributed lease when cancellation wins during Redis admission', async () => {
    let resolveAcquire: ((value: unknown) => void) | undefined;
    const evalMock = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            resolveAcquire = resolve;
          }),
      )
      .mockResolvedValueOnce(1);
    const admission = new CdseRenderAdmission({ eval: evalMock }, true);
    const controller = new AbortController();

    const acquiring = admission.acquire('tenant-a', 'cancelled-flight', controller.signal);
    controller.abort();
    resolveAcquire?.(1);

    await expect(acquiring).rejects.toMatchObject({ reason: 'CANCELLED' });
    await Promise.resolve();
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(String(evalMock.mock.calls[1]![0])).toContain("redis.call('GET', KEYS[3])");
  });

  it('binds release to a unique lease owner so a stale releaser cannot remove a successor', async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    const admission = new CdseRenderAdmission({ eval: evalMock }, true);

    const release = await admission.acquire('tenant-a', 'shared-flight');
    const acquireCall = evalMock.mock.calls[0]!;
    const acquireOwnerToken = acquireCall[7] as string;
    expect(acquireCall[1]).toBe(3);
    expect(acquireCall[4]).toBe('farm:cdse-render:v1:flight:shared-flight');
    expect(acquireOwnerToken).toEqual(expect.any(String));
    expect(acquireOwnerToken).not.toBe('shared-flight');

    release();
    await Promise.resolve();
    const releaseCall = evalMock.mock.calls[1]!;
    expect(releaseCall[1]).toBe(3);
    expect(releaseCall[4]).toBe('farm:cdse-render:v1:flight:shared-flight');
    expect(releaseCall[5]).toBe(acquireOwnerToken);
    expect(String(releaseCall[0])).toContain("redis.call('GET', KEYS[3]) ~= ARGV[1]");
  });
});
