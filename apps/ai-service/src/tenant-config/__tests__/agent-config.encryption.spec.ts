import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { TenantAgentConfig } from '../agent-config.entity';

/**
 * FAZ1-BYOK encryption-at-rest guard.
 *
 * The tenant AI keys MUST be encrypted at rest via the platform AES-256-GCM
 * transformer — a plaintext key column is a direct secret-exposure defect. This
 * spec asserts the entity wires the transformer on both key columns and that the
 * transformer produces authenticated ciphertext (enc: prefix) that round-trips,
 * WITHOUT leaking the plaintext into the stored form.
 */
describe('TenantAgentConfig key encryption-at-rest', () => {
  const columns = getMetadataArgsStorage().columns.filter(
    (c) => c.target === TenantAgentConfig,
  );

  /** Narrow view of the encrypting transformer so calls are typed (no `any`). */
  interface StringColumnTransformer {
    to(value: unknown): string | null | undefined;
    from(value: unknown): unknown;
  }

  const transformerFor = (propertyName: string): StringColumnTransformer => {
    const col = columns.find((c) => c.propertyName === propertyName);
    if (!col) throw new Error(`column ${propertyName} not found on entity`);
    const transformer = col.options.transformer;
    // May be a single transformer or an array; normalize to one.
    const single = Array.isArray(transformer) ? transformer[0] : transformer;
    if (!single) throw new Error(`column ${propertyName} has no transformer`);
    return single as StringColumnTransformer;
  };

  it.each(['anthropicApiKey', 'openaiApiKey'])(
    '%s column has an encrypting transformer',
    (prop) => {
      const t = transformerFor(prop);
      expect(t).toBeDefined();
      expect(typeof t?.to).toBe('function');
      expect(typeof t?.from).toBe('function');
    },
  );

  it('encrypts on write (enc: prefix, ciphertext ≠ plaintext) and decrypts on read', () => {
    const t = transformerFor('anthropicApiKey');
    const plaintext = 'sk-ant-super-secret-key-value';

    const stored = t.to(plaintext) as string;
    expect(stored).toEqual(expect.stringMatching(/^enc:/));
    expect(stored).not.toContain(plaintext); // the secret is never in the stored form

    const restored = t.from(stored);
    expect(restored).toBe(plaintext);
  });

  it('passes null/undefined through unchanged (unset key stays unset)', () => {
    const t = transformerFor('openaiApiKey');
    expect(t.to(null)).toBeNull();
    expect(t.to(undefined)).toBeUndefined();
    expect(t.from(null)).toBeNull();
  });

  it('does not double-encrypt an already-encrypted value (idempotent write)', () => {
    const t = transformerFor('anthropicApiKey');
    const once = t.to('sk-ant-x') as string;
    const twice = t.to(once) as string;
    expect(twice).toBe(once);
  });
});
