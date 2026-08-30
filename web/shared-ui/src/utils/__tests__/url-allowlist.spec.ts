import { describe, expect, it } from 'vitest';

import { validateNavigationUrl } from '../url-allowlist';

describe('validateNavigationUrl', () => {
  it.each([
    '/\\evil.example',
    '/%5cevil.example',
    '/%5C%5Cevil.example/steal',
    '/%2f%2fevil.example/steal',
  ])('rejects browser-normalizable external path %s', (url) => {
    expect(validateNavigationUrl(url)).toBeNull();
  });

  it.each([
    '/safe\u0000path',
    '/safe\t/evil.example',
    '/safe\r/evil.example',
    '/safe\n/evil.example',
    '/safe\u001fpath',
    '/safe\u007fpath',
  ])('rejects raw C0/DEL control characters in %s', (url) => {
    expect(validateNavigationUrl(url)).toBeNull();
  });

  it.each([
    '/%09/evil.example',
    '/%0d/evil.example',
    '/%0a/evil.example',
    '/safe%00path',
    '/safe%1fpath',
    '/safe%7fpath',
    '/%2509/evil.example',
  ])('rejects encoded or double-encoded control characters in %s', (url) => {
    expect(validateNavigationUrl(url)).toBeNull();
  });

  it('fails closed when an encoded octet remains after the decode budget', () => {
    expect(validateNavigationUrl('/%252525252561')).toBeNull();
  });

  it('rejects a navigation value over 4096 characters', () => {
    expect(validateNavigationUrl(`/${'a'.repeat(4096)}`)).toBeNull();
  });

  it('accepts an internal navigation value exactly 4096 characters long', () => {
    const url = `/${'a'.repeat(4095)}`;
    expect(validateNavigationUrl(url)).toBe(url);
  });

  it('preserves a valid internal path including query and fragment', () => {
    expect(validateNavigationUrl('/sites/setup/sites?tab=active#main')).toBe(
      '/sites/setup/sites?tab=active#main',
    );
  });

  it('preserves safe encoded query and fragment content', () => {
    expect(validateNavigationUrl('/search?q=fish%20farm#water%20quality')).toBe(
      '/search?q=fish%20farm#water%20quality',
    );
  });

  it('preserves an absolute URL on the production origin allowlist', () => {
    expect(validateNavigationUrl('https://app.suderra.com/sites?tab=active#main')).toBe(
      'https://app.suderra.com/sites?tab=active#main',
    );
  });

  it.each([
    '//evil.example/steal',
    'javascript:alert(1)',
    'data:text/html,malicious',
    'vbscript:msgbox(1)',
  ])('rejects protocol-relative and dangerous-scheme navigation %s', (url) => {
    expect(validateNavigationUrl(url)).toBeNull();
  });

  it('rejects malformed percent-encoded input', () => {
    expect(validateNavigationUrl('/%E0%A4%A')).toBeNull();
  });
});
