import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('script GraphQL client SSoT', () => {
  it('routes feed maintenance scripts through the shared GraphQL HTTP client', () => {
    const helper = read('scripts/lib/graphql-http-client.mjs');
    expect(helper).toContain('export function createGraphqlRequester');
    expect(helper).toContain('resolveTransport');
    expect(helper).toContain('endpointPath');

    for (const scriptPath of ['scripts/seed-feeds.js', 'scripts/update-feeds-max-weight.js']) {
      const script = read(scriptPath);
      expect(script).toContain("import { createGraphqlRequester } from './lib/graphql-http-client.mjs'");
      expect(script).toContain('const gqlRequest = createGraphqlRequester');
      expect(script).not.toContain("import http from 'node:http'");
      expect(script).not.toContain("hostname: 'localhost'");
      expect(script).not.toContain("path: '/graphql'");
      expect(script).not.toContain('JSON.parse(data)');
    }
  });
});
