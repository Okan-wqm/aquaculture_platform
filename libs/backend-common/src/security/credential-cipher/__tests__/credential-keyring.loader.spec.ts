import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREDENTIAL_CIPHER_ERROR_CODES,
  CredentialCipherError,
  type CredentialCipherErrorCode,
} from '../credential-cipher.errors';
import {
  CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV,
  CREDENTIAL_CIPHER_KEYRING_FILE_ENV,
} from '../credential-cipher.types';
import { loadCredentialCipherKeyring } from '../credential-keyring.loader';

interface TestKey {
  id: string;
  keyBase64: string;
}

interface InvalidKeyringConfiguration {
  file: string;
  active?: string;
}

const KEY_ONE = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64');
const KEY_TWO = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 65)).toString(
  'base64',
);
const KEY_THREE = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 129)).toString(
  'base64',
);

const temporaryDirectories: string[] = [];

function invalidConfigurationCases(): ReadonlyArray<
  readonly [string, InvalidKeyringConfiguration, CredentialCipherErrorCode]
> {
  return [
    [
      'missing active key id',
      { file: writeKeyring([{ id: 'key-one', keyBase64: KEY_ONE }]) },
      CREDENTIAL_CIPHER_ERROR_CODES.ACTIVE_KEY_ID_REQUIRED,
    ],
    [
      'unreadable keyring path',
      { file: '/definitely/not/a/credential-keyring.json', active: 'key-one' },
      CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_UNREADABLE,
    ],
    [
      'unsupported keyring version',
      {
        file: writeKeyring([{ id: 'key-one', keyBase64: KEY_ONE }], 2),
        active: 'key-one',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_VERSION_UNSUPPORTED,
    ],
    [
      'duplicate key id',
      {
        file: writeKeyring([
          { id: 'key-one', keyBase64: KEY_ONE },
          { id: 'key-one', keyBase64: KEY_TWO },
        ]),
        active: 'key-one',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.KEY_ID_DUPLICATE,
    ],
    [
      'active key absent from map',
      {
        file: writeKeyring([{ id: 'key-one', keyBase64: KEY_ONE }]),
        active: 'key-two',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.ACTIVE_KEY_NOT_FOUND,
    ],
    [
      'weak repeated-byte key',
      {
        file: writeKeyring([
          {
            id: 'key-one',
            keyBase64: Buffer.alloc(32, 7).toString('base64'),
          },
        ]),
        active: 'key-one',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_WEAK,
    ],
    [
      'duplicate key material under another id',
      {
        file: writeKeyring([
          { id: 'key-one', keyBase64: KEY_ONE },
          { id: 'key-two', keyBase64: KEY_ONE },
        ]),
        active: 'key-one',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_DUPLICATE,
    ],
    [
      'more than active and previous rotation keys',
      {
        file: writeKeyring([
          { id: 'key-one', keyBase64: KEY_ONE },
          { id: 'key-two', keyBase64: KEY_TWO },
          { id: 'key-three', keyBase64: KEY_THREE },
        ]),
        active: 'key-one',
      },
      CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_TOO_MANY_KEYS,
    ],
  ];
}

function writeKeyring(keys: readonly TestKey[], version = 1): string {
  const directory = mkdtempSync(join(tmpdir(), 'credential-keyring-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'keyring.json');
  writeFileSync(filePath, JSON.stringify({ version, keys }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

function expectCredentialCipherCode(
  operation: () => unknown,
  code: CredentialCipherErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCipherError);
    if (!(error instanceof CredentialCipherError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected credential cipher error ${code}`);
}

describe('credential keyring loader', () => {
  afterAll(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads an active key and a previous read key from a strict file-only map', () => {
    const keyring = loadCredentialCipherKeyring({
      [CREDENTIAL_CIPHER_KEYRING_FILE_ENV]: writeKeyring([
        { id: 'key-current', keyBase64: KEY_TWO },
        { id: 'key-previous', keyBase64: KEY_ONE },
      ]),
      [CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV]: 'key-current',
    });

    expect(keyring.activeKeyId).toBe('key-current');
    expect(keyring.activeKey().toString('base64')).toBe(KEY_TWO);
    expect(keyring.keyForRead('key-previous').toString('base64')).toBe(KEY_ONE);
    keyring.destroy();
  });

  it('does not accept inline key material when the mandatory file path is absent', () => {
    expectCredentialCipherCode(
      () =>
        loadCredentialCipherKeyring({
          CREDENTIAL_CIPHER_KEYRING: JSON.stringify({
            version: 1,
            keys: [{ id: 'inline-key', keyBase64: KEY_ONE }],
          }),
          [CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV]: 'inline-key',
        }),
      CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_REQUIRED,
    );
  });

  it.each(invalidConfigurationCases())(
    'fails closed for %s',
    (_label, configuration, expectedCode) => {
      expectCredentialCipherCode(
        () =>
          loadCredentialCipherKeyring({
            [CREDENTIAL_CIPHER_KEYRING_FILE_ENV]: configuration.file,
            [CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV]: configuration.active,
          }),
        expectedCode,
      );
    },
  );

  it('rejects malformed JSON without reflecting file contents in the error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'credential-keyring-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'malformed.json');
    const sensitiveFragment = 'fixture-key-material-must-not-escape';
    writeFileSync(filePath, `{${sensitiveFragment}`, 'utf8');

    try {
      loadCredentialCipherKeyring({
        [CREDENTIAL_CIPHER_KEYRING_FILE_ENV]: filePath,
        [CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV]: 'key-one',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialCipherError);
      if (!(error instanceof CredentialCipherError)) throw error;
      expect(error.code).toBe(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_MALFORMED);
      expect(error.message).not.toContain(sensitiveFragment);
      expect(error.stack ?? '').not.toContain(sensitiveFragment);
      return;
    }
    throw new Error('Expected malformed keyring to fail');
  });
});
