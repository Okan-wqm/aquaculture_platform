import { Logger } from '@nestjs/common';
import { ValueTransformer } from 'typeorm';
import { CredentialVaultService } from './credential-vault.service';

const logger = new Logger('CredentialVault');

// Static instance set during module init — TypeORM transformers can't use DI
let vaultInstance: CredentialVaultService | null = null;

export function setVaultInstance(vault: CredentialVaultService): void {
  vaultInstance = vault;
}

/**
 * The process-wide vault instance (set at module init). Null before init / in
 * migration contexts. Shared with the jsonb protocol-config transformer so both
 * transformers use one key + one crypto scheme.
 */
export function getVaultInstance(): CredentialVaultService | null {
  return vaultInstance;
}

export const EncryptedColumnTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null | undefined {
    if (!value) return value;
    if (!vaultInstance) {
      // SECURITY: refuse to store plaintext credentials
      logger.error('Vault not initialized - refusing to store plaintext credential');
      throw new Error('CredentialVault not initialized - cannot store sensitive data');
    }
    if (vaultInstance.isEncrypted(value)) return value;
    return vaultInstance.encrypt(value);
  },
  from(value: string | null | undefined): string | null | undefined {
    if (!value) return value;
    if (!vaultInstance) {
      // During startup/migrations, vault may not be ready yet - return raw value
      return value;
    }
    try {
      return vaultInstance.decrypt(value);
    } catch (err) {
      // SECURITY: never log credential content — only log opaque error code
      logger.error('Decryption failed for stored credential (value redacted)');
      return '[DECRYPTION_FAILED]';
    }
  },
};
