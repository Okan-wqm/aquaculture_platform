export const FIXTURE_PASSWORD = 'TestPassword123!';

/** Fixture mutation is allowed only against the isolated hosted database. */
export function assertIsolatedFixtureDatabase(): void {
  if (process.env['HOSTED_E2E_ISOLATED'] !== 'true') {
    throw new Error('Fixture writes require the isolated hosted E2E stack');
  }
  const database = process.env['DATABASE_URL'];
  if (!database) throw new Error('An explicit E2E database URL is required');
  const target = new URL(database);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/aquaculture_e2e') {
    throw new Error('Fixture writes require the loopback aquaculture_e2e database');
  }
}

interface LoginResponse {
  data?: { login: { accessToken: string; mfaRequired?: boolean; mfaSetupRequired?: boolean } };
  errors?: Array<{ message: string }>;
}

/** Obtain the normal RS256 access token through the actual password login endpoint. */
export async function loginFixtureUser(email: string, password: string): Promise<string> {
  const gateway = process.env['GATEWAY_URL'];
  if (!gateway || new URL(gateway).hostname !== 'localhost') throw new Error('Explicit hosted localhost gateway required');
  const response = await fetch(`${gateway}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Apollo-Require-Preflight': 'true' },
    body: JSON.stringify({ query: 'mutation FixtureLogin($input: LoginInput!) { login(input: $input) { accessToken mfaRequired mfaSetupRequired } }',
      variables: { input: { email, password } } }),
  });
  const body: LoginResponse = await response.json();
  if (!response.ok || body.errors || !body.data || !body.data.login.accessToken) {
    throw new Error('Fixture login did not issue an access token; inspect auth service proof');
  }
  const token = body.data.login.accessToken;
  const encodedHeader = token.split('.')[0];
  if (!encodedHeader) throw new Error('Malformed fixture access token');
  const header: { alg: string } = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Fixture login must use the production RS256 issuer');
  return token;
}
