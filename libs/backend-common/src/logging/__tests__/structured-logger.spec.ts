import { requestContextStorage, RequestContext } from '../request-context';
import { StructuredLoggerService } from '../structured-logger.service';

describe('StructuredLoggerService', () => {
  let logger: StructuredLoggerService;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    logger = new StructuredLoggerService('test-service', [
      'error',
      'warn',
      'log',
      'debug',
      'verbose',
    ]);
    stdoutChunks = [];
    stderrChunks = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdoutChunks.push(chunk.toString());
        return true;
      });
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(chunk.toString());
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function parseLastChunk(chunks: string[]): Record<string, unknown> {
    const lastChunk = chunks.at(-1);
    if (lastChunk === undefined) {
      throw new Error('Expected the logger to emit a JSON line');
    }

    const parsed: unknown = JSON.parse(lastChunk.trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected the logger to emit a JSON object');
    }

    return parsed as Record<string, unknown>;
  }

  function getLastStdout(): Record<string, unknown> {
    return parseLastChunk(stdoutChunks);
  }

  function getLastStderr(): Record<string, unknown> {
    return parseLastChunk(stderrChunks);
  }

  it('should output valid JSON to stdout for log()', () => {
    logger.log('Hello world');
    const entry = getLastStdout();

    expect(entry['level']).toBe('info');
    expect(entry['message']).toBe('Hello world');
    expect(entry['service']).toBe('test-service');
    expect(entry['timestamp']).toBeDefined();
  });

  it('should output valid JSON to stdout for warn()', () => {
    logger.warn('Something happened');
    const entry = getLastStdout();

    expect(entry['level']).toBe('warn');
    expect(entry['message']).toBe('Something happened');
  });

  it('should output to stderr for error()', () => {
    logger.error('Something broke');
    const entry = getLastStderr();

    expect(entry['level']).toBe('error');
    expect(entry['message']).toBe('Something broke');
    expect(entry['service']).toBe('test-service');
  });

  it('should include NestJS context when passed as last string param', () => {
    logger.log('Starting up', 'AppModule');
    const entry = getLastStdout();

    expect(entry['context']).toBe('AppModule');
    expect(entry['message']).toBe('Starting up');
  });

  it('should preserve the primary Error stack without serialising custom properties', () => {
    const err = Object.assign(new Error('test error'), {
      password: 'must-not-be-logged',
    });
    logger.error(err);
    const entry = getLastStderr();

    expect(entry['message']).toBe('test error');
    expect(entry['stack']).toBe(err.stack);
    expect(entry['extra']).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('must-not-be-logged');
  });

  it('should include stack trace for error() with string stack', () => {
    logger.error('Oh no', 'Error: oh no\n    at Test.fn (test.ts:1:1)');
    const entry = getLastStderr();

    expect(entry['stack']).toContain('Error: oh no');
  });

  it('should map "log" level to "info" severity', () => {
    logger.log('info test');
    const entry = getLastStdout();

    expect(entry['level']).toBe('info');
  });

  it('should include request context from AsyncLocalStorage', (done) => {
    const ctx: RequestContext = {
      traceId: 'abc123',
      correlationId: 'corr-456',
      tenantId: 'tenant-789',
      userId: 'user-000',
      spanId: 'span-111',
    };

    requestContextStorage.run(ctx, () => {
      logger.log('with context');
      const entry = getLastStdout();

      expect(entry['traceId']).toBe('abc123');
      expect(entry['correlationId']).toBe('corr-456');
      expect(entry['tenantId']).toBe('tenant-789');
      expect(entry['userId']).toBe('user-000');
      expect(entry['spanId']).toBe('span-111');
      done();
    });
  });

  it('should omit context fields when no request context is set', () => {
    logger.log('no context');
    const entry = getLastStdout();

    expect(entry['traceId']).toBeUndefined();
    expect(entry['correlationId']).toBeUndefined();
    expect(entry['tenantId']).toBeUndefined();
  });

  it('should mask sensitive keys in extra metadata', () => {
    logger.log('login attempt', { password: 'secret123', username: 'alice' });
    const entry = getLastStdout();
    const extra = entry['extra'] as Record<string, unknown>;

    expect(extra['password']).toBe('[REDACTED]');
    expect(extra['username']).toBe('alice');
  });

  it('should mask nested sensitive keys', () => {
    const data = {
      user: {
        name: 'alice',
        credentials: { token: 'abc', apiKey: 'xyz' },
      },
    };
    logger.log('nested sensitive', data);
    const entry = getLastStdout();
    const extra = entry['extra'] as Record<string, unknown>;
    const user = extra['user'] as Record<string, unknown>;
    const creds = user['credentials'] as Record<string, unknown>;

    expect(creds['token']).toBe('[REDACTED]');
    expect(creds['apiKey']).toBe('[REDACTED]');
    expect(user['name']).toBe('alice');
  });

  it('should respect log level filtering', () => {
    const restrictedLogger = new StructuredLoggerService('test', ['error', 'warn']);

    restrictedLogger.log('should be filtered');
    expect(stdoutSpy).not.toHaveBeenCalled();

    restrictedLogger.warn('should pass');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle debug and verbose levels', () => {
    logger.debug('debug msg');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const debugEntry = getLastStdout();
    expect(debugEntry['level']).toBe('debug');

    logger.verbose('verbose msg');
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
  });

  it('should handle non-string messages', () => {
    logger.log({ key: 'value' });
    const entry = getLastStdout();
    expect(entry['message']).toBe('{"key":"value"}');
  });

  it('should produce single-line JSON output', () => {
    logger.log('single line test');
    const rawOutput = stdoutChunks[0];
    if (rawOutput === undefined) {
      throw new Error('Expected the logger to emit a JSON line');
    }
    const lines = rawOutput.split('\n').filter((l: string) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });
});
