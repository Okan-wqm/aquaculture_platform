import { createHmac } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createTestTenant } from '../../fixtures/tenant.fixture';
import { createTestUser } from '../../fixtures/user.fixture';
import { TestDatabase } from '../../helpers/db.helper';
import { GraphQLTestClient } from '../../helpers/graphql-client';
import { FIXTURE_PASSWORD, isJsonObject } from '../../helpers/real-auth.fixture';

interface AccessClaims {
  sub: string;
  tenantId: string;
  jti: string;
  iat: number;
  exp: number;
  mfaVerified: boolean;
}

interface LoginResult {
  accessToken: string;
  mfaRequired: boolean;
  mfaToken: string | null;
}

/** RFC 6238 client authenticator; no server secret or stored recovery hash is read. */
function authenticatorCode(base32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of base32.replace(/=+$/u, '').toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('MFA returned an invalid base32 secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1];
  if (offset === undefined) throw new Error('Missing authenticator digest');
  return String((digest.readUInt32BE(offset & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function accessClaims(token: string): AccessClaims {
  const [encodedHeader, encodedPayload] = token.split('.');
  if (!encodedHeader || !encodedPayload) throw new Error('MFA did not issue a JWT');
  const header: unknown = JSON.parse(
    Buffer.from(encodedHeader, 'base64url').toString('utf8'),
  );
  if (!isJsonObject(header)) throw new Error('MFA returned an invalid JWT header');
  expect(header['alg']).toBe('RS256');
  const payload: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (
    !isJsonObject(payload) || typeof payload['sub'] !== 'string' ||
    typeof payload['tenantId'] !== 'string' || typeof payload['jti'] !== 'string' ||
    typeof payload['iat'] !== 'number' || !Number.isSafeInteger(payload['iat']) ||
    typeof payload['exp'] !== 'number' || !Number.isSafeInteger(payload['exp']) ||
    typeof payload['mfaVerified'] !== 'boolean'
  ) throw new Error('MFA returned invalid access claims');
  return {
    sub: payload['sub'], tenantId: payload['tenantId'], jti: payload['jti'],
    iat: payload['iat'], exp: payload['exp'], mfaVerified: payload['mfaVerified'],
  };
}

const LOGIN = `mutation Login($input: LoginInput!) {
  login(input: $input) { accessToken mfaRequired mfaToken }
}`;

test('real MFA enrollment, public login and step-up preserve session identity under tenant RLS', async ({
  request,
}) => {
  test.setTimeout(60_000);
  const db = new TestDatabase();
  const client = new GraphQLTestClient(request);
  try {
    const tenant = await createTestTenant(db);
    const user = await createTestUser(db, { tenantId: tenant.id });
    const setup = await client.mutate<{ setupMfa: { secret: string; recoveryCodes: string[] } }>(
      'mutation { setupMfa { secret recoveryCodes } }',
      {},
      { token: user.token },
    );
    expect(setup.body.errors).toBeUndefined();
    const enrollment = setup.body.data?.setupMfa;
    if (!enrollment) throw new Error('MFA setup returned no enrollment material');
    const confirmed = await client.mutate<{ verifyMfaSetup: { success: boolean } }>(
      'mutation VerifyMfaSetup($input: VerifyMfaSetupInput!) { verifyMfaSetup(input: $input) { success } }',
      { input: { code: authenticatorCode(enrollment.secret) } },
      { token: user.token },
    );
    expect(confirmed.body.errors).toBeUndefined();
    expect(confirmed.body.data?.verifyMfaSetup.success).toBe(true);

    const login = await client.mutate<{ login: LoginResult }>(LOGIN, {
      input: { email: user.email, password: FIXTURE_PASSWORD },
    });
    expect(login.body.errors).toBeUndefined();
    expect(login.body.data?.login.accessToken).toBe('');
    expect(login.body.data?.login.mfaRequired).toBe(true);
    const challenge = login.body.data?.login.mfaToken;
    const [loginCode, stepUpCode] = enrollment.recoveryCodes;
    if (!challenge || !loginCode || !stepUpCode)
      throw new Error('Missing MFA challenge or recovery codes');
    const before = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM auth.refresh_tokens WHERE "userId" = $1',
      [user.id],
    );
    const verified = await client.mutate<{
      verifyMfaLogin: { accessToken: string; refreshToken: string };
    }>(
      'mutation VerifyMfaLogin($input: VerifyMfaLoginInput!) { verifyMfaLogin(input: $input) { accessToken refreshToken } }',
      { input: { mfaToken: challenge, code: loginCode } },
    );
    expect(verified.body.errors).toBeUndefined();
    const token = verified.body.data?.verifyMfaLogin.accessToken;
    if (!token) throw new Error('Public MFA verification did not issue access');
    expect(verified.body.data?.verifyMfaLogin.refreshToken).toBe('');
    expect(verified.headers['set-cookie']).toContain('refresh_token=');
    const original = accessClaims(token);
    expect(original).toMatchObject({ sub: user.id, tenantId: tenant.id, mfaVerified: true });
    const currentUser = await client.query<{ currentUser: { id: string } }>(
      'query { currentUser { id } }',
      {},
      { token },
    );
    expect(currentUser.body.errors).toBeUndefined();
    expect(currentUser.body.data?.currentUser.id).toBe(user.id);
    const after = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM auth.refresh_tokens WHERE "userId" = $1',
      [user.id],
    );
    expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);

    const elevated = await client.mutate<{
      mfaStepUp: { accessToken: string; refreshToken: string };
    }>(
      'mutation StepUp($input: MfaStepUpInput!) { mfaStepUp(input: $input) { accessToken refreshToken } }',
      { input: { code: stepUpCode } },
      { token },
    );
    expect(elevated.body.errors).toBeUndefined();
    const elevatedToken = elevated.body.data?.mfaStepUp.accessToken;
    if (!elevatedToken) throw new Error('MFA step-up did not issue access');
    const elevatedClaims = accessClaims(elevatedToken);
    expect(elevatedClaims).toMatchObject({
      sub: user.id,
      jti: original.jti,
      iat: original.iat,
      mfaVerified: true,
    });
    expect(elevatedClaims.exp).toBeLessThanOrEqual(original.exp);
    expect(elevatedClaims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
    expect(elevated.headers['set-cookie']).toBeUndefined();
    expect(elevated.body.data?.mfaStepUp.refreshToken).toBe('');
    const afterStepUp = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM auth.refresh_tokens WHERE "userId" = $1',
      [user.id],
    );
    expect(afterStepUp.rows).toEqual(after.rows);

    const nextLogin = await client.mutate<{ login: LoginResult }>(LOGIN, {
      input: { email: user.email, password: FIXTURE_PASSWORD },
    });
    const nextChallenge = nextLogin.body.data?.login.mfaToken;
    if (!nextChallenge) throw new Error('Expected a new signed MFA challenge');
    const replay = await client.mutate<{ verifyMfaLogin: { accessToken: string } }>(
      'mutation VerifyMfaLogin($input: VerifyMfaLoginInput!) { verifyMfaLogin(input: $input) { accessToken } }',
      { input: { mfaToken: nextChallenge, code: loginCode } },
    );
    expect(replay.body.errors?.length).toBeGreaterThan(0);
    expect(replay.body.data?.verifyMfaLogin?.accessToken).toBeFalsy();
    const afterReplay = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM auth.refresh_tokens WHERE "userId" = $1',
      [user.id],
    );
    expect(afterReplay.rows).toEqual(after.rows);
  } finally {
    await db.close();
  }
});
