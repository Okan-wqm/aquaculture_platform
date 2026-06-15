import { classifyEndpoint, DEFAULT_TIER } from '../edge/endpoint-classifier';
import { RateLimitEndpointBucket } from '../rate-limit.types';

const BUCKETS: readonly RateLimitEndpointBucket[] = [
  { tier: 'login', paths: ['/api/auth/login', '/auth/login'] },
  { tier: 'upload', paths: ['/api/files/upload', '/api/v1/files/upload'] },
];

describe('classifyEndpoint — exact match (SECREV-LOW-001 cure)', () => {
  it('maps exact login paths to the login tier', () => {
    expect(classifyEndpoint('/api/auth/login', BUCKETS)).toBe('login');
    expect(classifyEndpoint('/auth/login', BUCKETS)).toBe('login');
  });

  it('maps exact upload paths to the upload tier', () => {
    expect(classifyEndpoint('/api/files/upload', BUCKETS)).toBe('upload');
    expect(classifyEndpoint('/api/v1/files/upload', BUCKETS)).toBe('upload');
  });

  it('does NOT match a suffix-attack path', () => {
    // Pre-cure endsWith(/auth/login) would have matched this.
    expect(classifyEndpoint('/auth/login/foo', BUCKETS)).toBe(DEFAULT_TIER);
  });

  it('does NOT match a substring-attack path', () => {
    // Pre-cure includes(/upload) would have matched this unrelated endpoint.
    expect(classifyEndpoint('/api/v2/wrap/upload-something', BUCKETS)).toBe(DEFAULT_TIER);
  });

  it('strips the query string before matching', () => {
    expect(classifyEndpoint('/auth/login?next=/x', BUCKETS)).toBe('login');
  });

  it('strips trailing slashes before matching', () => {
    expect(classifyEndpoint('/auth/login/', BUCKETS)).toBe('login');
    expect(classifyEndpoint('/api/files/upload///', BUCKETS)).toBe('upload');
  });

  it('returns default for unmatched, empty, and root paths', () => {
    expect(classifyEndpoint('/graphql', BUCKETS)).toBe(DEFAULT_TIER);
    expect(classifyEndpoint('', BUCKETS)).toBe(DEFAULT_TIER);
    expect(classifyEndpoint(undefined, BUCKETS)).toBe(DEFAULT_TIER);
  });
});
