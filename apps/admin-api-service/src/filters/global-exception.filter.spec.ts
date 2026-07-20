import type { ArgumentsHost } from '@nestjs/common';

import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * Regression guard for APA-030: this APP_FILTER formats an HTTP error envelope.
 * In the hybrid app it also catches errors thrown by NATS (rpc) message
 * handlers, where there is no HTTP response to write. It must rethrow so Nest's
 * microservice exception layer applies its retry/nack policy. Before the fix
 * the filter called host.switchToHttp().getResponse() unconditionally.
 */
describe('GlobalExceptionFilter — hybrid-app RPC rethrow (APA-030)', () => {
  // Fully-typed ArgumentsHost double: every method is a jest.fn() (assignable to
  // the framework interface), so no cast is needed. `httpResponse`, when given,
  // records the status()/json() calls of the http branch.
  function argumentsHost(
    type: 'http' | 'rpc',
    httpResponse?: { status: jest.Mock },
  ): ArgumentsHost {
    const host: ArgumentsHost = {
      getType: jest.fn(),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      switchToHttp: jest.fn(),
    };
    (host.getType as jest.Mock).mockReturnValue(type);
    (host.switchToHttp as jest.Mock).mockImplementation(() => {
      if (!httpResponse) {
        throw new Error('switchToHttp() must not be called for an rpc context');
      }
      return {
        getResponse: () => httpResponse,
        getRequest: () => ({ url: '/v1/tenants', method: 'POST', headers: {} }),
        getNext: () => ({}),
      };
    });
    return host;
  }

  it('rethrows for a non-http (rpc) context instead of writing an HTTP response', () => {
    const filter = new GlobalExceptionFilter();
    const original = new Error('onboarding ack write failed');

    expect(() => filter.catch(original, argumentsHost('rpc'))).toThrow(original);
  });

  it('writes an HTTP error envelope for an http context', () => {
    const filter = new GlobalExceptionFilter();
    const json = jest.fn();
    const status = jest.fn();
    status.mockReturnValue({ json });

    filter.catch(new Error('boom'), argumentsHost('http', { status }));

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, statusCode: 500 }));
  });
});
