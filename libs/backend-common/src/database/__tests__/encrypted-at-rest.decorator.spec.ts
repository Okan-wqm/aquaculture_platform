import 'reflect-metadata';

import {
  EncryptedAtRest,
  ENCRYPTED_AT_REST_META_KEY,
  getEncryptedAtRestForProperty,
  getEncryptedAtRestMetadata,
  type EncryptedAtRestOptions,
} from '../encrypted-at-rest.decorator';

describe('@EncryptedAtRest decorator', () => {
  it('attaches metadata discoverable via getEncryptedAtRestMetadata', () => {
    class Employee {
      @EncryptedAtRest({ keyId: 'tenant-pii-v1', algorithm: 'pgp_sym' })
      nationalId!: Buffer;
    }

    const meta = getEncryptedAtRestMetadata(Employee);
    expect(meta.size).toBe(1);
    expect(meta.get('nationalId')).toEqual({
      keyId: 'tenant-pii-v1',
      algorithm: 'pgp_sym',
      propertyKey: 'nationalId',
    });
  });

  it('stores under the shared metadata key so other modules can read it', () => {
    class Foo {
      @EncryptedAtRest({ keyId: 'k1', algorithm: 'aes_256_gcm' })
      secret!: Buffer;
    }

    const raw: unknown = Reflect.getMetadata(ENCRYPTED_AT_REST_META_KEY, Foo);
    expect(raw).toBeInstanceOf(Map);
    if (!(raw instanceof Map)) {
      throw new Error('Expected encrypted metadata map');
    }
    expect(raw.has('secret')).toBe(true);
  });

  it('supports multiple decorated properties on the same class', () => {
    class MultiSecret {
      @EncryptedAtRest({ keyId: 'a', algorithm: 'pgp_sym' })
      a!: Buffer;

      @EncryptedAtRest({ keyId: 'b', algorithm: 'pgp_pub' })
      b!: Buffer;
    }

    const meta = getEncryptedAtRestMetadata(MultiSecret);
    expect(meta.size).toBe(2);
    expect(meta.get('a')?.algorithm).toBe('pgp_sym');
    expect(meta.get('b')?.algorithm).toBe('pgp_pub');
  });

  it('getEncryptedAtRestForProperty returns undefined for undecorated property', () => {
    class Bar {
      @EncryptedAtRest({ keyId: 'x', algorithm: 'pgp_sym' })
      secret!: Buffer;

      public clear!: string;
    }

    expect(getEncryptedAtRestForProperty(Bar, 'secret')).toBeDefined();
    expect(getEncryptedAtRestForProperty(Bar, 'clear')).toBeUndefined();
  });

  it('returns an empty map for classes with no decorated properties', () => {
    class Plain {
      public name!: string;
    }

    const meta = getEncryptedAtRestMetadata(Plain);
    expect(meta.size).toBe(0);
  });

  it('throws on empty keyId', () => {
    expect(() => EncryptedAtRest({ keyId: '', algorithm: 'pgp_sym' })).toThrow(/keyId/);
  });

  it('throws on unsupported algorithm', () => {
    const invalid = { keyId: 'k', algorithm: 'rot13' } as unknown as EncryptedAtRestOptions;
    expect(() => EncryptedAtRest(invalid)).toThrow(/allowlist/);
  });

  it('supports the optional reason field for audit trails', () => {
    class WithReason {
      @EncryptedAtRest({
        keyId: 'kvkk-ssn-v1',
        algorithm: 'pgp_sym',
        reason: 'KVKK Art 6 — sensitive personal data',
      })
      ssn!: Buffer;
    }

    const meta = getEncryptedAtRestMetadata(WithReason).get('ssn');
    expect(meta?.reason).toContain('KVKK');
  });
});
