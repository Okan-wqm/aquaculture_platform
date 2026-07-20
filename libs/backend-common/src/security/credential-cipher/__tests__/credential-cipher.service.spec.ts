import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';

import {
  CREDENTIAL_CIPHER_ERROR_CODES,
  CredentialCipherError,
  type CredentialCipherErrorCode,
} from '../credential-cipher.errors';
import { CredentialCipherModule } from '../credential-cipher.module';
import { CredentialCipherService } from '../credential-cipher.service';
import type { CredentialCipherAad } from '../credential-cipher.types';
import {
  CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV,
  CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS,
  CREDENTIAL_CIPHER_MAX_PLAINTEXT_BYTES,
  CREDENTIAL_CIPHER_KEYRING_FILE_ENV,
} from '../credential-cipher.types';

interface TestKey {
  id: string;
  keyBase64: string;
}

const OLD_KEY_BASE64 = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
  'base64',
);
const ACTIVE_KEY_BASE64 = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 65),
).toString('base64');

const BASE_AAD: CredentialCipherAad = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  table: 'marine_provider_credentials',
  rowId: '22222222-2222-4222-8222-222222222222',
  provider: 'CMEMS',
  purpose: 'username-password',
  credentialGeneration: 7,
};

const temporaryDirectories: string[] = [];
const services: CredentialCipherService[] = [];
const originalFileEnv = process.env[CREDENTIAL_CIPHER_KEYRING_FILE_ENV];
const originalActiveEnv = process.env[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV];

function writeKeyring(keys: readonly TestKey[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'credential-cipher-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'keyring.json');
  writeFileSync(filePath, JSON.stringify({ version: 1, keys }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

function initializeService(activeKeyId: string, keys: readonly TestKey[]): CredentialCipherService {
  process.env[CREDENTIAL_CIPHER_KEYRING_FILE_ENV] = writeKeyring(keys);
  process.env[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV] = activeKeyId;
  const service = new CredentialCipherService();
  service.onModuleInit();
  services.push(service);
  return service;
}

function expectCredentialCipherCode(
  operation: () => unknown,
  code: CredentialCipherErrorCode,
): CredentialCipherError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCipherError);
    if (!(error instanceof CredentialCipherError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected credential cipher error ${code}`);
}

function mutateBase64Url(value: string): string {
  if (value.length === 0) return 'A';
  const replacement = value[0] === 'A' ? 'B' : 'A';
  return replacement + value.slice(1);
}

function mutateEnvelopePart(envelope: string, partIndex: number): string {
  const parts = envelope.split(':');
  const value = parts[partIndex];
  if (value === undefined) throw new Error('Envelope fixture is incomplete');
  parts[partIndex] = mutateBase64Url(value);
  return parts.join(':');
}

describe('CredentialCipherService', () => {
  afterEach(() => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    if (originalFileEnv === undefined) {
      Reflect.deleteProperty(process.env, CREDENTIAL_CIPHER_KEYRING_FILE_ENV);
    } else {
      process.env[CREDENTIAL_CIPHER_KEYRING_FILE_ENV] = originalFileEnv;
    }
    if (originalActiveEnv === undefined) {
      Reflect.deleteProperty(process.env, CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV);
    } else {
      process.env[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV] = originalActiveEnv;
    }
  });

  it('writes only with the active key and decrypts nondeterministic GCM envelopes', () => {
    const service = initializeService('key-active', [
      { id: 'key-old', keyBase64: OLD_KEY_BASE64 },
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);

    const first = service.encrypt('fixture-provider-secret', BASE_AAD);
    const second = service.encrypt('fixture-provider-secret', BASE_AAD);

    expect(first.keyId).toBe('key-active');
    expect(first.envelope).toMatch(/^cred:v1:key-active:/);
    expect(second.envelope).not.toBe(first.envelope);
    expect(service.decrypt(first.envelope, BASE_AAD)).toBe('fixture-provider-secret');
  });

  it('round-trips the worst-case envelope boundary and rejects one plaintext byte more', () => {
    const worstCaseKeyId = 'k'.repeat(64);
    const service = initializeService(worstCaseKeyId, [
      { id: worstCaseKeyId, keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    const boundaryPlaintext = 'a'.repeat(CREDENTIAL_CIPHER_MAX_PLAINTEXT_BYTES);

    const encrypted = service.encrypt(boundaryPlaintext, BASE_AAD);

    expect(encrypted.envelope).toHaveLength(CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS);
    expect(service.decrypt(encrypted.envelope, BASE_AAD)).toBe(boundaryPlaintext);
    expectCredentialCipherCode(
      () => service.encrypt(`${boundaryPlaintext}a`, BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.PLAINTEXT_TOO_LARGE,
    );
  });

  it('reads a previous key and explicitly re-encrypts it onto the active key', () => {
    const oldService = initializeService('key-old', [{ id: 'key-old', keyBase64: OLD_KEY_BASE64 }]);
    const oldEnvelope = oldService.encrypt('fixture-rotated-secret', BASE_AAD).envelope;
    oldService.onModuleDestroy();

    const rotatingService = initializeService('key-active', [
      { id: 'key-old', keyBase64: OLD_KEY_BASE64 },
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    expect(rotatingService.decrypt(oldEnvelope, BASE_AAD)).toBe('fixture-rotated-secret');

    const result = rotatingService.reencrypt(oldEnvelope, BASE_AAD);
    expect(result).toMatchObject({
      oldKeyId: 'key-old',
      newKeyId: 'key-active',
      changed: true,
    });
    expect(result.envelope).not.toBe(oldEnvelope);
    expect(rotatingService.decrypt(result.envelope, BASE_AAD)).toBe('fixture-rotated-secret');

    expect(rotatingService.reencrypt(result.envelope, BASE_AAD)).toEqual({
      envelope: result.envelope,
      oldKeyId: 'key-active',
      newKeyId: 'key-active',
      changed: false,
    });

    const afterOldKeyRemoval = initializeService('key-active', [
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    expectCredentialCipherCode(
      () => afterOldKeyRemoval.decrypt(oldEnvelope, BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.KEY_NOT_FOUND,
    );
    expect(afterOldKeyRemoval.decrypt(result.envelope, BASE_AAD)).toBe('fixture-rotated-secret');
  });

  it.each([
    ['tenantId', { ...BASE_AAD, tenantId: '33333333-3333-4333-8333-333333333333' }],
    ['table', { ...BASE_AAD, table: 'another_credentials_table' }],
    ['rowId', { ...BASE_AAD, rowId: '44444444-4444-4444-8444-444444444444' }],
    ['provider', { ...BASE_AAD, provider: 'CDSE' }],
    ['purpose', { ...BASE_AAD, purpose: 'client-secret' }],
    [
      'credentialGeneration',
      { ...BASE_AAD, credentialGeneration: BASE_AAD.credentialGeneration + 1 },
    ],
  ] as const)('rejects substitution of AAD field %s', (_field, substitutedAad) => {
    const service = initializeService('key-active', [
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    const encrypted = service.encrypt('fixture-provider-secret', BASE_AAD);

    expectCredentialCipherCode(
      () => service.decrypt(encrypted.envelope, substitutedAad),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });

  it('uses collision-safe canonical AAD rather than delimiter concatenation', () => {
    const service = initializeService('key-active', [
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    const firstContext = {
      ...BASE_AAD,
      table: 'alpha|beta',
      rowId: 'gamma',
    };
    const delimiterCollisionContext = {
      ...BASE_AAD,
      table: 'alpha',
      rowId: 'beta|gamma',
    };
    const encrypted = service.encrypt('fixture-provider-secret', firstContext);

    expectCredentialCipherCode(
      () => service.decrypt(encrypted.envelope, delimiterCollisionContext),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
  });

  it('rejects a malformed runtime AAD with a typed failure', () => {
    const service = initializeService('key-active', [
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);

    expectCredentialCipherCode(() => {
      Reflect.apply(service.encrypt, service, ['fixture-provider-secret', null]);
    }, CREDENTIAL_CIPHER_ERROR_CODES.AAD_INVALID);
  });

  it('rejects ciphertext, tag, key-id, and version tampering with typed failures', () => {
    const service = initializeService('key-active', [
      { id: 'key-old', keyBase64: OLD_KEY_BASE64 },
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    const encrypted = service.encrypt('fixture-provider-secret', BASE_AAD);

    expectCredentialCipherCode(
      () => service.decrypt(mutateEnvelopePart(encrypted.envelope, 5), BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    expectCredentialCipherCode(
      () => service.decrypt(mutateEnvelopePart(encrypted.envelope, 3), BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    expectCredentialCipherCode(
      () => service.decrypt(mutateEnvelopePart(encrypted.envelope, 4), BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    expectCredentialCipherCode(
      () => service.decrypt(encrypted.envelope.replace(':key-active:', ':key-old:'), BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    expectCredentialCipherCode(
      () => service.decrypt(encrypted.envelope.replace('cred:v1:', 'cred:v2:'), BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_VERSION_UNSUPPORTED,
    );
  });

  it('never reflects plaintext, ciphertext, or key material in hard failures', () => {
    const plaintext = 'fixture-high-value-provider-secret';
    const service = initializeService('key-active', [
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    const encrypted = service.encrypt(plaintext, BASE_AAD);
    const tampered = mutateEnvelopePart(encrypted.envelope, 5);

    const error = expectCredentialCipherCode(
      () => service.decrypt(tampered, BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED,
    );
    const observableError = [error.message, error.stack ?? '', JSON.stringify(error)].join('\n');
    for (const forbidden of [plaintext, encrypted.envelope, tampered, ACTIVE_KEY_BASE64]) {
      expect(observableError).not.toContain(forbidden);
    }
  });

  it('fails before use when the Nest lifecycle has not initialized the provider', () => {
    const service = new CredentialCipherService();
    expectCredentialCipherCode(
      () => service.encrypt('fixture-secret', BASE_AAD),
      CREDENTIAL_CIPHER_ERROR_CODES.NOT_INITIALIZED,
    );
  });

  it('makes missing keyring configuration fatal during Nest module startup', async () => {
    Reflect.deleteProperty(process.env, CREDENTIAL_CIPHER_KEYRING_FILE_ENV);
    process.env[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV] = 'key-active';
    const moduleRef = await Test.createTestingModule({
      imports: [CredentialCipherModule],
    }).compile();
    await expect(async () => moduleRef.init()).rejects.toMatchObject({
      code: CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_REQUIRED,
    });
  });

  it('exports an initialized cipher provider from the Nest module', async () => {
    process.env[CREDENTIAL_CIPHER_KEYRING_FILE_ENV] = writeKeyring([
      { id: 'key-active', keyBase64: ACTIVE_KEY_BASE64 },
    ]);
    process.env[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV] = 'key-active';
    let moduleRef: TestingModule | undefined;
    try {
      moduleRef = await Test.createTestingModule({
        imports: [CredentialCipherModule],
      }).compile();
      await moduleRef.init();
      const service = moduleRef.get(CredentialCipherService);
      expect(service.activeKeyId()).toBe('key-active');
      expect(service.decrypt(service.encrypt('fixture-secret', BASE_AAD).envelope, BASE_AAD)).toBe(
        'fixture-secret',
      );
    } finally {
      await moduleRef?.close();
    }
  });
});
