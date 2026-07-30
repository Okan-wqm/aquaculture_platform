import { createMockResponse, getResponseBody, getResponseStatus } from './mock-types';

describe('mock response accessors', () => {
  it('returns undefined when the response has no recorded calls', () => {
    const response = createMockResponse();

    expect(getResponseBody(response)).toBeUndefined();
    expect(getResponseStatus(response)).toBeUndefined();
  });

  it('returns the latest recorded body and status', () => {
    const response = createMockResponse();

    response.status(202);
    response.status(204);
    response.json({ state: 'accepted' });
    response.json({ state: 'completed' });

    expect(getResponseStatus(response)).toBe(204);
    expect(getResponseBody(response)).toEqual({ state: 'completed' });
  });
});
