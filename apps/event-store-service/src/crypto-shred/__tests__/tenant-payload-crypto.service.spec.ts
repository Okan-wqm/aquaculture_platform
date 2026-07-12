/**
 * TenantPayloadCryptoService — event-store crypto-shred core (DB-INFRA-HIGH-003 Part B).
 *
 * Pins the crypto-shred guarantees in isolation (before any live-path wiring):
 * per-tenant DEKs, encrypt→decrypt roundtrip, cross-tenant isolation, and — the
 * GDPR mechanism — that shredding a tenant's key makes its ciphertext
 * permanently unrecoverable while leaving other tenants untouched.
 */
import {
  TenantPayloadCryptoService,
  TenantPayloadShreddedError,
} from '../tenant-payload-crypto.service';
import type { TenantPayloadKey } from '../entities/tenant-payload-key.entity';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** In-memory TenantPayloadKey repository backing the service's persistence. */
function makeFakeRepo(store: Map<string, TenantPayloadKey> = new Map()) {
  const repo = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = store.get(where.tenantId as string);
      if (!row) return null;
      // Emulate the `shreddedAt: IsNull()` filtered read.
      if ('shreddedAt' in where && row.shreddedAt) return null;
      return row;
    }),
    save: jest.fn(async (row: TenantPayloadKey) => {
      store.set(row.tenantId, row);
      return row;
    }),
    createQueryBuilder: jest.fn(() => {
      let pending: Partial<TenantPayloadKey> = {};
      const qb: Record<string, unknown> = {
        insert: () => qb,
        into: () => qb,
        values: (v: Partial<TenantPayloadKey>) => {
          pending = v;
          return qb;
        },
        orIgnore: () => qb,
        execute: async () => {
          const id = pending.tenantId as string;
          if (store.has(id)) return { identifiers: [] };
          store.set(id, {
            ...(pending as TenantPayloadKey),
            createdAt: new Date(),
            shreddedAt: null,
          });
          return { identifiers: [{ tenantId: id }] };
        },
      };
      return qb;
    }),
    __store: store,
  };
  return repo;
}

const config = {
  get: (k: string) =>
    k === 'EVENT_STORE_PAYLOAD_KEK' ? 'a'.repeat(64) : k === 'NODE_ENV' ? 'test' : undefined,
};

function makeService(repo: ReturnType<typeof makeFakeRepo>) {
  return new TenantPayloadCryptoService(repo as never, config as never);
}

describe('TenantPayloadCryptoService', () => {
  it('roundtrips encrypt → decrypt for a tenant', async () => {
    const svc = makeService(makeFakeRepo());
    const ct = await svc.encrypt(TENANT_A, 'sensitive payload');
    expect(ct.startsWith('enc:')).toBe(true);
    expect(await svc.decrypt(TENANT_A, ct)).toBe('sensitive payload');
  });

  it('uses a distinct DEK per tenant (cross-tenant ciphertext is not decryptable)', async () => {
    const repo = makeFakeRepo();
    const svc = makeService(repo);
    const ctA = await svc.encrypt(TENANT_A, 'A-secret');
    await svc.encrypt(TENANT_B, 'B-secret');
    // Two distinct wrapped DEKs were minted.
    expect(repo.__store.get(TENANT_A)!.wrappedDek).not.toEqual(
      repo.__store.get(TENANT_B)!.wrappedDek,
    );
    // Tenant A's ciphertext decrypted under tenant B's key fails (GCM auth).
    await expect(svc.decrypt(TENANT_B, ctA)).rejects.toThrow();
  });

  it('crypto-shred makes the tenant ciphertext permanently unrecoverable', async () => {
    const repo = makeFakeRepo();
    const svc = makeService(repo);
    const ct = await svc.encrypt(TENANT_A, 'to be erased');

    await svc.shred(TENANT_A);

    expect(await svc.isShredded(TENANT_A)).toBe(true);
    // The wrapped DEK is overwritten with unrecoverable random data.
    expect(repo.__store.get(TENANT_A)!.wrappedDek.startsWith('shredded:')).toBe(true);
    await expect(svc.decrypt(TENANT_A, ct)).rejects.toBeInstanceOf(TenantPayloadShreddedError);
  });

  it('shred is idempotent and scoped to one tenant', async () => {
    const repo = makeFakeRepo();
    const svc = makeService(repo);
    const ctB = await svc.encrypt(TENANT_B, 'B stays readable');
    await svc.encrypt(TENANT_A, 'A erased');

    await svc.shred(TENANT_A);
    await svc.shred(TENANT_A); // no-op second time

    expect(await svc.isShredded(TENANT_B)).toBe(false);
    expect(await svc.decrypt(TENANT_B, ctB)).toBe('B stays readable'); // other tenant intact
  });

  it('passes legacy plaintext (no enc: prefix) through decrypt', async () => {
    const svc = makeService(makeFakeRepo());
    expect(await svc.decrypt(TENANT_A, 'legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('refuses to encrypt for an already-shredded tenant (fresh instance, no cache)', async () => {
    const store = new Map<string, TenantPayloadKey>();
    const svc = makeService(makeFakeRepo(store));
    await svc.encrypt(TENANT_A, 'x');
    await svc.shred(TENANT_A);

    // A fresh instance sharing the same persistence has no cached DEK — encrypt
    // must fail closed rather than mint a NEW key for an erased tenant.
    const fresh = makeService(makeFakeRepo(store));
    await expect(fresh.encrypt(TENANT_A, 'y')).rejects.toBeInstanceOf(TenantPayloadShreddedError);
  });
});
