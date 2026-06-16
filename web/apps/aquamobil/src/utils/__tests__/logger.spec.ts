// FE-HIGH-056 — structured logger sink.
//
// The logger is the single sanctioned path to the console in AquaMobil (every
// other file is under `no-console: error`). These tests prove the contract the
// rest of the app depends on:
//   - error/warn ALWAYS forward to the console (field diagnostics)
//   - debug/info forward ONLY in a DEV build (production stays quiet)
//   - the forwarded args are passed through verbatim (no data transform)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../logger';

describe('logger (FE-HIGH-056)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the real console methods the logger forwards to via
    // globalThis.console[level]. Implementations are stubbed to no-op so the
    // test output stays clean.
    errorSpy = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(globalThis.console, 'info').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(globalThis.console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('forwards error() to console.error with the exact args', () => {
    const err = new Error('boom');
    logger.error('prefix', err, 42);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('prefix', err, 42);
  });

  it('forwards warn() to console.warn with the exact args', () => {
    logger.warn('careful', { detail: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('careful', { detail: 1 });
  });

  it('error/warn forward regardless of DEV (they are field diagnostics)', () => {
    vi.stubEnv('DEV', false);
    logger.error('e');
    logger.warn('w');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('debug/info forward when DEV is true', () => {
    vi.stubEnv('DEV', true);
    logger.debug('d');
    logger.info('i');
    expect(debugSpy).toHaveBeenCalledWith('d');
    expect(infoSpy).toHaveBeenCalledWith('i');
  });

  it('debug/info NO-OP when DEV is false (production stays quiet)', () => {
    vi.stubEnv('DEV', false);
    logger.debug('d');
    logger.info('i');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
