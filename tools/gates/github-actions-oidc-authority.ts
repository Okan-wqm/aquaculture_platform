import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

import {
  FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS,
  type FindingWriterRegistryMutationOperation,
} from './lib/finding-writer-cli-contract';
import { AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY } from './lib/automation-publication-policy';

const ISSUER = 'https://token.actions.githubusercontent.com';
const OPENID_CONFIGURATION_URL = `${ISSUER}/.well-known/openid-configuration`;
const EXPECTED_JWKS_URL = `${ISSUER}/.well-known/jwks`;
const EXPECTED_REPOSITORY = 'Okan-wqm/aquaculture_platform';
const EXPECTED_REPOSITORY_ID = '1132698735';
const EXPECTED_REPOSITORY_OWNER_ID = '77401788';
const EXPECTED_REF = 'refs/heads/main';
const EXPECTED_AUDIENCE = 'aqua-finding-registry-authority-v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_JWT_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface OidcConfiguration {
  readonly issuer: string;
  readonly jwksUri: string;
}

interface JwkSet {
  readonly keys: JsonWebKey[];
}

interface ParsedJwt {
  readonly signingInput: Buffer;
  readonly signature: Buffer;
  readonly header: JsonRecord;
  readonly claims: JsonRecord;
}

export interface RepositoryMutationAuthority {
  readonly kind: 'GITHUB_ACTIONS_OIDC_V1';
  readonly repository: string;
  readonly repositoryId: string;
  readonly operation: RegistryMutationOperation;
  readonly commandId: string;
  readonly inputSha256: string;
  readonly effectiveAt: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly tokenId: string;
  readonly expiresAt: string;
}

export interface RepositoryMutationAuthorityDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly nowSeconds?: () => number;
  readonly fetchJson?: (
    url: string,
    init?: { readonly headers?: Readonly<Record<string, string>> },
  ) => Promise<unknown>;
}

export interface TrustedWorkflowPolicy {
  readonly workflowRef: string;
  readonly events: readonly string[];
  readonly operations: readonly RegistryMutationOperation[];
}

export type RegistryMutationOperation = FindingWriterRegistryMutationOperation;

function freezeTrustedWorkflowPolicy(policy: TrustedWorkflowPolicy): TrustedWorkflowPolicy {
  return Object.freeze({
    ...policy,
    events: Object.freeze([...policy.events]),
    operations: Object.freeze([...policy.operations]),
  });
}

export const FINDING_WRITER_TRUSTED_WORKFLOW_POLICY = Object.freeze([
  ...AUTOMATION_REGISTRY_WRITER_WORKFLOW_POLICY.map((policy) =>
    freezeTrustedWorkflowPolicy({
      workflowRef: policy.workflowRef,
      events: policy.workflowEvents,
      operations: policy.operations,
    }),
  ),
]);

function assertTrustedWorkflowPolicyClosed(): void {
  const workflowRefs = FINDING_WRITER_TRUSTED_WORKFLOW_POLICY.map((policy) => policy.workflowRef);
  if (new Set(workflowRefs).size !== workflowRefs.length) {
    throw new Error('Finding writer trusted-workflow policy contains duplicate workflow refs');
  }
  const governedOperations = [
    ...new Set(FINDING_WRITER_TRUSTED_WORKFLOW_POLICY.flatMap((policy) => policy.operations)),
  ].sort();
  const mutationOperations = [...FINDING_WRITER_REGISTRY_MUTATION_OPERATIONS].sort();
  if (JSON.stringify(governedOperations) !== JSON.stringify(mutationOperations)) {
    throw new Error(
      `Finding writer trusted-workflow operation coverage drifted: governed=${governedOperations.join(',')} mutations=${mutationOperations.join(',')}`,
    );
  }
}

assertTrustedWorkflowPolicyClosed();

const ISSUED_AUTHORITIES = new WeakMap<object, bigint>();
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value as number;
}

function parseBoundedJson(text: string, field: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`${field} exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
}

async function defaultFetchJson(
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: init?.headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
    ) {
      throw new Error('response content-length is invalid or too large');
    }
    return parseBoundedJson(await response.text(), url);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeJwtSegment(segment: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`${field} is not canonical base64url`);
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw new Error(`${field} is not canonical base64url`);
  }
  return decoded;
}

function parseJwt(jwt: string): ParsedJwt {
  if (Buffer.byteLength(jwt, 'utf8') > MAX_JWT_BYTES) {
    throw new Error(`GitHub OIDC JWT exceeds ${MAX_JWT_BYTES} bytes`);
  }
  const segments = jwt.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error('GitHub OIDC response is not a compact JWT');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const headerValue = parseBoundedJson(
    decodeJwtSegment(encodedHeader, 'JWT header').toString('utf8'),
    'JWT header',
  );
  const claimsValue = parseBoundedJson(
    decodeJwtSegment(encodedClaims, 'JWT claims').toString('utf8'),
    'JWT claims',
  );
  if (!isRecord(headerValue) || !isRecord(claimsValue)) {
    throw new Error('GitHub OIDC JWT header and claims must be objects');
  }
  return {
    signingInput: Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'),
    signature: decodeJwtSegment(encodedSignature, 'JWT signature'),
    header: headerValue,
    claims: claimsValue,
  };
}

function parseOidcConfiguration(value: unknown): OidcConfiguration {
  if (!isRecord(value)) {
    throw new Error('GitHub OIDC configuration must be an object');
  }
  const issuer = requireString(value.issuer, 'oidc.issuer');
  const jwksUri = requireString(value.jwks_uri, 'oidc.jwks_uri');
  if (issuer !== ISSUER || jwksUri !== EXPECTED_JWKS_URL) {
    throw new Error('GitHub OIDC discovery returned an untrusted issuer or JWKS endpoint');
  }
  return { issuer, jwksUri };
}

function parseJwkSet(value: unknown): JwkSet {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new Error('GitHub OIDC JWKS must contain a keys array');
  }
  const keys = value.keys.filter(isRecord).map((key) => key as JsonWebKey);
  if (keys.length !== value.keys.length || keys.length === 0 || keys.length > 32) {
    throw new Error('GitHub OIDC JWKS has an invalid key set');
  }
  return { keys };
}

function requireClaimMatch(claims: JsonRecord, field: string, expected: string): void {
  const actual = requireString(claims[field], `jwt.${field}`);
  if (actual !== expected) {
    throw new Error(`jwt.${field} must equal ${expected}`);
  }
}

function validateAudience(value: unknown): void {
  const audiences =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value
        : null;
  if (!audiences || audiences.length !== 1 || audiences[0] !== EXPECTED_AUDIENCE) {
    throw new Error(`jwt.aud must contain only ${EXPECTED_AUDIENCE}`);
  }
}

function validateClaims(
  claims: JsonRecord,
  env: NodeJS.ProcessEnv,
  nowSeconds: number,
  operation: RegistryMutationOperation,
): RepositoryMutationAuthority {
  requireClaimMatch(claims, 'iss', ISSUER);
  validateAudience(claims.aud);
  requireClaimMatch(claims, 'repository', EXPECTED_REPOSITORY);
  requireClaimMatch(claims, 'repository_id', EXPECTED_REPOSITORY_ID);
  requireClaimMatch(claims, 'repository_owner_id', EXPECTED_REPOSITORY_OWNER_ID);
  requireClaimMatch(claims, 'ref', EXPECTED_REF);
  const subject = requireString(claims.sub, 'jwt.sub');
  const acceptedSubjects = new Set([
    `repo:${EXPECTED_REPOSITORY}:ref:${EXPECTED_REF}`,
    `repo:Okan-wqm@${EXPECTED_REPOSITORY_OWNER_ID}/aquaculture_platform@${EXPECTED_REPOSITORY_ID}:ref:${EXPECTED_REF}`,
  ]);
  if (!acceptedSubjects.has(subject)) {
    throw new Error('jwt.sub is not the exact mutable-name or immutable-id protected-main subject');
  }
  if (claims.ref_protected !== true && claims.ref_protected !== 'true') {
    throw new Error('jwt.ref_protected must attest protected main');
  }
  requireClaimMatch(claims, 'sha', requireString(env.GITHUB_SHA, 'GITHUB_SHA'));
  requireClaimMatch(claims, 'run_id', requireString(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'));
  requireClaimMatch(
    claims,
    'run_attempt',
    requireString(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
  );
  requireClaimMatch(
    claims,
    'runner_environment',
    requireString(env.RUNNER_ENVIRONMENT, 'RUNNER_ENVIRONMENT'),
  );
  const workflowRef = requireString(claims.workflow_ref, 'jwt.workflow_ref');
  requireClaimMatch(
    claims,
    'workflow_sha',
    requireString(env.GITHUB_WORKFLOW_SHA, 'GITHUB_WORKFLOW_SHA'),
  );
  const eventName = requireString(claims.event_name, 'jwt.event_name');
  const trustedWorkflow = FINDING_WRITER_TRUSTED_WORKFLOW_POLICY.find(
    (candidate) =>
      candidate.workflowRef === workflowRef &&
      candidate.events.includes(eventName) &&
      candidate.operations.includes(operation),
  );
  if (!trustedWorkflow) {
    throw new Error(
      `jwt workflow/event is not a trusted registry mutation authority: ${workflowRef}`,
    );
  }
  if (env.GITHUB_WORKFLOW_REF !== workflowRef || env.GITHUB_EVENT_NAME !== eventName) {
    throw new Error('GitHub runner identity differs from the signed OIDC workflow identity');
  }
  if (
    env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY ||
    env.GITHUB_REPOSITORY_ID !== EXPECTED_REPOSITORY_ID ||
    env.GITHUB_REPOSITORY_OWNER_ID !== EXPECTED_REPOSITORY_OWNER_ID ||
    env.GITHUB_REF !== EXPECTED_REF ||
    env.GITHUB_REF_PROTECTED !== 'true'
  ) {
    throw new Error('Registry mutation authority must execute from protected main');
  }
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Registry mutation authority requires an isolated GitHub-hosted runner');
  }

  const issuedAt = requireInteger(claims.iat, 'jwt.iat');
  const notBefore = requireInteger(claims.nbf, 'jwt.nbf');
  const expiresAt = requireInteger(claims.exp, 'jwt.exp');
  if (
    issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
    notBefore > nowSeconds + CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds ||
    expiresAt - issuedAt <= 0 ||
    expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('GitHub OIDC token is outside its bounded validity window');
  }

  const commandId = requireString(env.FINDING_COMMAND_ID, 'FINDING_COMMAND_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,199}$/.test(commandId)) {
    throw new Error('FINDING_COMMAND_ID has an invalid canonical shape');
  }
  const inputSha256 = requireString(env.FINDING_INPUT_SHA256, 'FINDING_INPUT_SHA256');
  if (!/^[0-9a-f]{64}$/.test(inputSha256)) {
    throw new Error('FINDING_INPUT_SHA256 must be a lowercase SHA-256 digest');
  }
  const effectiveAt = requireString(env.FINDING_EFFECTIVE_AT, 'FINDING_EFFECTIVE_AT');
  const parsedEffectiveAt = Date.parse(effectiveAt);
  if (
    !Number.isFinite(parsedEffectiveAt) ||
    new Date(parsedEffectiveAt).toISOString() !== effectiveAt
  ) {
    throw new Error('FINDING_EFFECTIVE_AT must be a canonical UTC ISO timestamp');
  }

  const authority: RepositoryMutationAuthority = Object.freeze({
    kind: 'GITHUB_ACTIONS_OIDC_V1',
    repository: EXPECTED_REPOSITORY,
    repositoryId: EXPECTED_REPOSITORY_ID,
    operation,
    commandId,
    inputSha256,
    effectiveAt,
    workflowRef,
    workflowSha: requireString(claims.workflow_sha, 'jwt.workflow_sha'),
    runId: requireString(claims.run_id, 'jwt.run_id'),
    runAttempt: requireString(claims.run_attempt, 'jwt.run_attempt'),
    tokenId: requireString(claims.jti, 'jwt.jti'),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
  const remainingValiditySeconds = expiresAt - nowSeconds;
  ISSUED_AUTHORITIES.set(
    authority,
    process.hrtime.bigint() + BigInt(remainingValiditySeconds) * NANOSECONDS_PER_SECOND,
  );
  return authority;
}

export async function acquireRepositoryMutationAuthority(
  operation: RegistryMutationOperation,
  dependencies: RepositoryMutationAuthorityDependencies = {},
): Promise<RepositoryMutationAuthority> {
  const env = dependencies.env ?? process.env;
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error(
      'Canonical finding mutation is available only to GitHub Actions OIDC authority',
    );
  }
  const requestUrl = requireString(
    env.ACTIONS_ID_TOKEN_REQUEST_URL,
    'ACTIONS_ID_TOKEN_REQUEST_URL',
  );
  const requestToken = requireString(
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  );
  const url = new URL(requestUrl);
  if (
    url.protocol !== 'https:' ||
    (!url.hostname.endsWith('.actions.githubusercontent.com') &&
      url.hostname !== 'actions.githubusercontent.com') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('ACTIONS_ID_TOKEN_REQUEST_URL is not a trusted GitHub Actions endpoint');
  }
  url.searchParams.set('audience', EXPECTED_AUDIENCE);

  const fetchJson = dependencies.fetchJson ?? defaultFetchJson;
  const tokenResponse = await fetchJson(url.toString(), {
    headers: { Authorization: `bearer ${requestToken}` },
  });
  if (!isRecord(tokenResponse)) {
    throw new Error('GitHub OIDC token response must be an object');
  }
  const jwt = requireString(tokenResponse.value, 'oidc-token.value');
  const parsed = parseJwt(jwt);
  if (
    parsed.header.alg !== 'RS256' ||
    parsed.header.typ !== 'JWT' ||
    typeof parsed.header.kid !== 'string' ||
    parsed.header.kid.length === 0
  ) {
    throw new Error('GitHub OIDC JWT must use a keyed RS256 JWT header');
  }

  const configuration = parseOidcConfiguration(await fetchJson(OPENID_CONFIGURATION_URL));
  const jwks = parseJwkSet(await fetchJson(configuration.jwksUri));
  const candidates = jwks.keys.filter(
    (key) =>
      key.kid === parsed.header.kid &&
      key.kty === 'RSA' &&
      (key.use === undefined || key.use === 'sig') &&
      (key.alg === undefined || key.alg === 'RS256'),
  );
  if (candidates.length !== 1) {
    throw new Error('GitHub OIDC JWT key id does not resolve to exactly one trusted RSA key');
  }
  const key = createPublicKey({ key: candidates[0] as JsonWebKey, format: 'jwk' });
  if (!verifySignature('RSA-SHA256', parsed.signingInput, key, parsed.signature)) {
    throw new Error('GitHub OIDC JWT signature verification failed');
  }

  return validateClaims(
    parsed.claims,
    env,
    dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
    operation,
  );
}

export function assertRepositoryMutationAuthority(
  authority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
): void {
  const monotonicDeadline = ISSUED_AUTHORITIES.get(authority);
  if (
    monotonicDeadline === undefined ||
    process.hrtime.bigint() > monotonicDeadline ||
    authority.operation !== operation ||
    authority.repository !== EXPECTED_REPOSITORY ||
    authority.repositoryId !== EXPECTED_REPOSITORY_ID
  ) {
    throw new Error(`Repository mutation authority does not authorize ${operation}`);
  }
}
