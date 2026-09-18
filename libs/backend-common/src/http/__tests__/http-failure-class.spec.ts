import { classifyHttpStatus, signedFetchJson } from '../http-failure-class';
import { signedFetch } from '../signed-http-client';

jest.mock('../signed-http-client', () => ({ signedFetch: jest.fn() }));

const mockSignedFetch = signedFetch as jest.MockedFunction<typeof signedFetch>;
const OPTIONS = { serviceName: 'notification-service', tenantId: '', audience: 'auth-service' };

describe('classifyHttpStatus (PLAT-HIGH-902 retry-decision SSoT)', () => {
  it.each([undefined, 500, 502, 503, 504, 401, 403, 408, 429])(
    'classifies %p as transient',
    (status) => {
      expect(classifyHttpStatus(status)).toBe('transient');
    },
  );

  it.each([400, 404, 409, 410, 422, 451])('classifies %p as permanent', (status) => {
    expect(classifyHttpStatus(status)).toBe('permanent');
  });
});

describe('signedFetchJson', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the decoded body on success', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ email: 'a@example.test' }),
    } as Response);
    await expect(signedFetchJson<{ email: string }>('http://auth/pii', OPTIONS)).resolves.toEqual({
      ok: true,
      status: 200,
      body: { email: 'a@example.test' },
    });
  });

  it('classifies an HTTP failure by status', async () => {
    mockSignedFetch.mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(signedFetchJson('http://auth/pii', OPTIONS)).resolves.toEqual({
      ok: false,
      status: 404,
      failureClass: 'permanent',
      error: 'HTTP 404',
    });
    mockSignedFetch.mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(signedFetchJson('http://auth/pii', OPTIONS)).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 503, failureClass: 'transient' }),
    );
  });

  it('classifies a thrown network error as transient', async () => {
    mockSignedFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(signedFetchJson('http://auth/pii', OPTIONS)).resolves.toEqual({
      ok: false,
      failureClass: 'transient',
      error: 'ECONNREFUSED',
    });
  });

  it('classifies a non-JSON 2xx body as permanent', async () => {
    mockSignedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as Response);
    await expect(signedFetchJson('http://auth/pii', OPTIONS)).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 200, failureClass: 'permanent' }),
    );
  });
});
