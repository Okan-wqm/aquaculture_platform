import * as crypto from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import express, { NextFunction, Response } from 'express';

import { JwtMiddleware } from '../../middleware/jwt.middleware';
import { TokenBlacklistStore } from '../../guards/redis-token-blacklist.store';
import { AuthenticatedRequest } from '../../types/index';
import {
  MODULE_ACCESS_CLAIM_METRIC,
  MODULE_ACCESS_CLAIM_REGISTRY,
} from '../module-access-claim.metrics';

async function countOf(claim: 'present' | 'absent' | 'malformed'): Promise<number> {
  const metric = MODULE_ACCESS_CLAIM_REGISTRY.getSingleMetric(MODULE_ACCESS_CLAIM_METRIC);
  if (!metric) throw new Error(`${MODULE_ACCESS_CLAIM_METRIC} is not registered`);
  const { values } = await metric.get();
  return values.find((value) => value.labels['claim'] === claim)?.value ?? 0;
}

/**
 * The R2 entry gate of the module-boundaries plan reads the share of access tokens that carry
 * `moduleAccess` (PKG-04 accept: 100% one access-token TTL after R1). Only the gateway sees
 * every token, whichever auth replica minted it, so the gateway counts each verified access
 * token by its claim: present, absent (minted before R1, or by an auth replica not yet
 * replaced) or malformed.
 */
describe('gateway_access_token_module_access_total (PKG-04 accept, RBAC-HIGH-028)', () => {
  const issuer = 'module-access-claim-test-issuer';
  const audience = 'module-access-claim-test-audience';
  const keyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwtService = new JwtService({});
  const middleware = new JwtMiddleware(
    jwtService,
    new ConfigService({
      NODE_ENV: 'production',
      JWT_PUBLIC_KEY: keyPair.publicKey,
      JWT_ISSUER: issuer,
      JWT_AUDIENCE: audience,
    }),
    {
      isBlacklisted: jest.fn().mockResolvedValue(false),
      isValidToken: jest.fn().mockResolvedValue(true),
    } satisfies TokenBlacklistStore,
  );

  async function authenticate(claims: Record<string, unknown>): Promise<AuthenticatedRequest> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = jwtService.sign(
      {
        sub: 'user-1',
        tenantId: 'tenant-1',
        roles: ['MODULE_USER'],
        type: 'access',
        jti: crypto.randomUUID(),
        iat: issuedAt,
        exp: issuedAt + 600,
        iss: issuer,
        aud: audience,
        ...claims,
      },
      { privateKey: keyPair.privateKey, algorithm: 'RS256' },
    );
    const request: AuthenticatedRequest = Object.create(express.request);
    request.headers = { authorization: `Bearer ${token}` };
    request.method = 'POST';
    request.url = '/graphql';
    const next: NextFunction = jest.fn();
    const response: Response = Object.create(express.response);
    await middleware.use(request, response, next);
    return request;
  }

  it.each<['present' | 'absent' | 'malformed', Record<string, unknown>]>([
    ['present', { moduleAccess: { farm: 'MODULE_MANAGER' } }],
    ['present', { moduleAccess: {} }],
    ['absent', {}],
    ['malformed', { moduleAccess: { alert: 'MODULE_USER' } }],
  ])('counts a verified token whose claim is %s', async (claim, claims) => {
    const before = await countOf(claim);

    const request = await authenticate(claims);

    expect(request.user?.sub).toBe('user-1');
    expect(await countOf(claim)).toBe(before + 1);
  });

  it('counts nothing for a request without a bearer token', async () => {
    const before = {
      present: await countOf('present'),
      absent: await countOf('absent'),
      malformed: await countOf('malformed'),
    };
    const request: AuthenticatedRequest = Object.create(express.request);
    request.headers = {};

    await middleware.use(request, Object.create(express.response), jest.fn());

    expect({
      present: await countOf('present'),
      absent: await countOf('absent'),
      malformed: await countOf('malformed'),
    }).toEqual(before);
  });
});
